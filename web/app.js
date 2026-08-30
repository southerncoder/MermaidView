// MermaidView Canvas App
// Renders all mermaid diagrams on a zoomable canvas with live updates via WebSocket.

const SERVER = window.location.origin;
let diagrams = [];
let renderCounter = 0;
let ws = null;
let reconnectTimeout = null;
// Set after a card drag so the trailing click/dblclick doesn't fire actions.
let cardClickSuppressUntil = 0;
// Active search query (lowercase); empty shows everything.
let filterQuery = '';

// Render cache keyed by contentHash → { svg, width?, height? }
const renderCache = new Map();
// Pending render debounce timers keyed by diagram id
const renderTimers = new Map();
const RENDER_DEBOUNCE_MS = 200;

// IntersectionObserver for lazy rendering
let visibilityObserver = null;
const visibleCards = new Set();

// ---- Persisted layout ----
const LAYOUT_KEY = 'mermaidView.layout.v1';
const VIEW_KEY = 'mermaidView.view.v1';
const ARRANGE_KEY = 'mermaidView.arrange.v1';
const COLLAPSE_KEY = 'mermaidView.collapsed.v1';
let cardPositions = loadStore(LAYOUT_KEY, {}); // diagram id → {x, y} in canvas coords
let arrangeMode = loadStore(ARRANGE_KEY, 'grouped') === 'free' ? 'free' : 'grouped';
let collapsedFiles = loadStore(COLLAPSE_KEY, {}); // file uri → true
// Active editor file as reported by the server (didOpen/didChange).
let activeFile = null;
// File view selection: 'all' | '__active' | specific file uri.
let fileFilter = 'all';

function loadStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : fallback;
  } catch (err) {
    return fallback;
  }
}

let saveLayoutTimer = null;
function saveLayout() {
  clearTimeout(saveLayoutTimer);
  saveLayoutTimer = setTimeout(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(cardPositions));
    } catch (err) {
      /* storage may be unavailable (private mode); layout stays session-only */
    }
  }, 300);
}

function saveStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    /* ignore */
  }
}

function saveArrange() {
  saveStore(ARRANGE_KEY, arrangeMode);
}

function saveCollapsed() {
  saveStore(COLLAPSE_KEY, collapsedFiles);
}

let saveViewTimer = null;
function saveView() {
  clearTimeout(saveViewTimer);
  saveViewTimer = setTimeout(() => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(canvasState));
    } catch (err) {
      /* ignore */
    }
  }, 300);
}

// ---- Card dragging ----
let activeCardDrag = null;

function beginCardDrag(e, card, diagram) {
  if (e.button !== 0) return;
  if (e.target.closest('.card-footer') || e.target.closest('button')) return;

  const cardRect = card.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  const startX = (cardRect.left - canvasRect.left) / canvasState.scale;
  const startY = (cardRect.top - canvasRect.top) / canvasState.scale;

  // Dragging a grouped card switches the canvas to free (pinned) layout:
  // that's the "lock in my arrangement" behavior.
  if (arrangeMode === 'grouped') {
    arrangeMode = 'free';
    saveArrange();
    // Lift this card out of its section into the canvas root.
    if (card.parentElement !== canvas) canvas.appendChild(card);
    // Sections that lost all cards get cleaned up on next render.
  }

  // Promote to an absolutely positioned card anchored at its current spot.
  card.style.position = 'absolute';
  card.style.left = `${startX}px`;
  card.style.top = `${startY}px`;
  card.style.margin = '0';
  card.classList.add('card-dragging');

  activeCardDrag = {
    card,
    diagram,
    startX,
    startY,
    pointerStart: { x: e.clientX, y: e.clientY },
    moved: false,
  };
  e.preventDefault();
  e.stopPropagation();
}

function updateCardDrag(e) {
  const info = activeCardDrag;
  if (!info) return;
  const dx = (e.clientX - info.pointerStart.x) / canvasState.scale;
  const dy = (e.clientY - info.pointerStart.y) / canvasState.scale;
  if (!info.moved && Math.hypot(dx, dy) < 4) return;
  info.moved = true;
  info.card.style.left = `${info.startX + dx}px`;
  info.card.style.top = `${info.startY + dy}px`;
}

function endCardDrag() {
  const info = activeCardDrag;
  if (!info) return;
  activeCardDrag = null;
  info.card.classList.remove('card-dragging');
  if (!info.moved) return;

  cardPositions[info.diagram.id] = {
    x: parseFloat(info.card.style.left) || 0,
    y: parseFloat(info.card.style.top) || 0,
  };
  saveLayout();
  // Suppress the click-to-source + dblclick-focus the mouseup would trigger.
  cardClickSuppressUntil = Date.now() + 350;
}

function resetLayout() {
  cardPositions = {};
  saveLayout();
  arrangeMode = 'grouped';
  saveArrange();
  renderCanvas();
}

// ---- Grouped file sections ----
let sectionRoots = new Map(); // file uri → { section, grid, header }

function fileSectionInfo(uri, diagramsForFile) {
  let entry = sectionRoots.get(uri);
  if (!entry || !entry.section.isConnected) {
    const section = document.createElement('div');
    section.className = 'file-section';
    section.dataset.file = uri;

    const header = document.createElement('div');
    header.className = 'file-header';

    const title = document.createElement('span');
    title.className = 'file-title';
    header.appendChild(title);

    const toggle = document.createElement('button');
    toggle.className = 'file-collapse';
    toggle.title = 'Collapse/expand this file';
    header.appendChild(toggle);

    const grid = document.createElement('div');
    grid.className = 'file-grid';

    section.appendChild(header);
    section.appendChild(grid);

    header.addEventListener('click', (e) => {
      if (e.target === toggle) {
        collapsedFiles[uri] = !collapsedFiles[uri];
        if (!collapsedFiles[uri]) delete collapsedFiles[uri];
        saveCollapsed();
        renderCanvas();
      }
    });

    entry = { section, grid, header, title, toggle };
    sectionRoots.set(uri, entry);
  }

  entry.section.classList.toggle('collapsed', Boolean(collapsedFiles[uri]));
  entry.title.textContent = `${basename(uri)} · ${diagramsForFile.length} diagram${diagramsForFile.length !== 1 ? 's' : ''}`;
  entry.toggle.textContent = collapsedFiles[uri] ? '▸' : '▾';
  return entry;
}

function renderCanvas() {
  const visible = visibleDiagrams();

  // Cards are never destroyed on mode switches — re-parent them.
  if (arrangeMode === 'grouped') {
    // Clear any leftover free pins from the canvas root.
    canvas.querySelectorAll(':scope > .diagram-card').forEach((c) => {
      c.style.position = '';
      c.style.left = '';
      c.style.top = '';
      c.style.margin = '';
    });

    // Remove stale sections, then (re)build in file order.
    canvas.querySelectorAll('.file-section').forEach((el) => el.remove());
    sectionRoots.clear();

    const byFile = new Map();
    for (const d of visible) {
      if (!byFile.has(d.file)) byFile.set(d.file, []);
      byFile.get(d.file).push(d);
    }
    // Sort diagrams within each file by line, files by basename:
    const files = [...byFile.keys()].sort((a, b) =>
      basename(a).localeCompare(basename(b))
    );
    const frag = document.createDocumentFragment();
    for (const uri of files) {
      const list = byFile.get(uri).sort((a, b) => a.lineStart - b.lineStart);
      const entry = fileSectionInfo(uri, list);
      for (const d of list) {
        const card = ensureCard(d);
        entry.grid.appendChild(card);
      }
      frag.appendChild(entry.section);
    }
    canvas.appendChild(frag);
  } else {
    // Free mode: plain positioned canvas, no sections.
    sectionRoots.clear();
    canvas.querySelectorAll('.file-section').forEach((el) => el.remove());
    for (const d of visible) {
      const card = ensureCard(d);
      if (card.parentElement !== canvas) canvas.appendChild(card);
      applySavedPosition(card, d);
    }
  }

  if (visible.length === 0) {
    ensureEmptyState();
  } else {
    const emptyState = canvas.querySelector('.empty-state');
    if (emptyState) emptyState.remove();
  }
  refreshCardVisibility();
  updateStatusFromWs();
}

function ensureCard(diagram) {
  let card = getCard(diagram);
  if (!card) {
    card = createCard(diagram);
    canvas.appendChild(card);
    ensureVisibilityObserver();
    visibilityObserver.observe(card);
  }
  updateCardMeta(card, diagram);
  return card;
}

// ---- Canvas pan/zoom ----
const canvasContainer = document.getElementById('canvas-container');
const canvas = document.getElementById('canvas');
const savedView = loadStore(VIEW_KEY, null);
let canvasState =
  savedView && Number.isFinite(savedView.x) && Number.isFinite(savedView.y) && Number.isFinite(savedView.scale)
    ? { x: savedView.x, y: savedView.y, scale: Math.min(5, Math.max(0.1, savedView.scale)) }
    : { x: 0, y: 0, scale: 1 };
let isDragging = false;
let dragStart = { x: 0, y: 0 };

function updateTransform() {
  canvas.style.transform = `translate(${canvasState.x}px, ${canvasState.y}px) scale(${canvasState.scale})`;
  saveView();
}

canvasContainer.addEventListener('mousedown', (e) => {
  if (e.target.closest('.diagram-card')) return;
  isDragging = true;
  dragStart = { x: e.clientX - canvasState.x, y: e.clientY - canvasState.y };
});

window.addEventListener('mousemove', (e) => {
  if (activeCardDrag) {
    updateCardDrag(e);
    return;
  }
  if (!isDragging) return;
  canvasState.x = e.clientX - dragStart.x;
  canvasState.y = e.clientY - dragStart.y;
  updateTransform();
});

window.addEventListener('mouseup', () => { isDragging = false; endCardDrag(); });

canvasContainer.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  const rect = canvasContainer.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  const newScale = Math.max(0.1, Math.min(5, canvasState.scale * delta));
  const ratio = newScale / canvasState.scale;

  canvasState.x = mouseX - ratio * (mouseX - canvasState.x);
  canvasState.y = mouseY - ratio * (mouseY - canvasState.y);
  canvasState.scale = newScale;
  updateTransform();
}, { passive: false });

document.getElementById('btn-fit').addEventListener('click', fitAll);
document.getElementById('btn-reset').addEventListener('click', () => {
  canvasState = { x: 0, y: 0, scale: 1 };
  updateTransform();
});

function fitAll() {
  const cards = [...canvas.querySelectorAll('.diagram-card')].filter(
    (c) => !c.classList.contains('hidden')
  );
  if (cards.length === 0) return;

  // Union of card bounds in canvas coordinates (works for flow + pinned cards).
  const canvasRect = canvas.getBoundingClientRect();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const card of cards) {
    const r = card.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const x = (r.left - canvasRect.left) / canvasState.scale;
    const y = (r.top - canvasRect.top) / canvasState.scale;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + r.width / canvasState.scale);
    maxY = Math.max(maxY, y + r.height / canvasState.scale);
  }

  const containerRect = canvasContainer.getBoundingClientRect();
  const pad = 24;
  const boundW = Math.max(1, maxX - minX + pad * 2);
  const boundH = Math.max(1, maxY - minY + pad * 2);
  canvasState.scale = Math.min(
    (containerRect.width - 40) / boundW,
    (containerRect.height - 40) / boundH,
    1
  );
  canvasState.x = 20 - (minX - pad) * canvasState.scale;
  canvasState.y = 20 - (minY - pad) * canvasState.scale;
  updateTransform();
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (presentState) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') {
      e.preventDefault();
      presentStep(1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      presentStep(-1);
    } else if (e.key === 'Home') {
      presentState.i = 0;
      renderPresentSlide();
    } else if (e.key === 'End') {
      presentState.i = presentState.list.length - 1;
      renderPresentSlide();
    } else if (e.key === 'Escape') {
      closePresentation();
    }
    return;
  }
  if (e.target === searchInput) {
    if (e.key === 'Escape') {
      searchInput.value = '';
      applyFilter();
      searchInput.blur();
    }
    return;
  }
  if (e.key === '/' || (e.key === 'f' && (e.ctrlKey || e.metaKey))) {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  
  // Open import panel with Alt+I (Ctrl+Shift+I conflicts with Chrome DevTools)
  if ((e.altKey && e.key === 'I')) {
    if (importPanelEl) toggleImportPanel();
    return;
  }
  
  if (e.key === 'f' || e.key === 'F') fitAll();
  if (e.key === 'p' || e.key === 'P') startPresentation();
  if (e.key === 'r' || e.key === 'R') {
    canvasState = { x: 0, y: 0, scale: 1 };
    updateTransform();
  }
  if (e.key === '+' || e.key === '=') {
    canvasState.scale = Math.min(5, canvasState.scale * 1.2);
    updateTransform();
  }
  if (e.key === '-') {
    canvasState.scale = Math.max(0.1, canvasState.scale * 0.8);
    updateTransform();
  }
});

// ---- Theme ----
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
    if (typeof mermaid !== 'undefined') {
      mermaid.initialize({
        startOnLoad: false,
        theme: theme === 'light' ? 'default' : 'dark',
        securityLevel: 'loose',
      });
    }
  }
}

// ---- Mermaid initialization ----
function initMermaid() {
  if (typeof mermaid !== 'undefined') {
    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    mermaid.initialize({
      startOnLoad: false,
      theme: theme === 'light' ? 'default' : 'dark',
      securityLevel: 'loose',
    });
    console.log('Mermaid initialized');
  }
}

// ---- WebSocket connection ----
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/ws`;

  const socket = new WebSocket(url);
  socket.addEventListener('open', () => {
    setStatus(liveStatus(' (live)'), 'connected');
    clearTimeout(reconnectTimeout);
  });

  socket.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'init' || msg.type === 'update') {
        scheduleDiagramsUpdate(msg.diagrams || []);
      } else if (msg.type === 'theme') {
        applyTheme(msg.theme);
        // Re-render visible cards so mermaid theme takes effect
        scheduleDiagramsUpdate(diagrams);
      } else if (msg.type === 'activeFile') {
        activeFile = msg.file || null;
        if (fileFilter === '__active') {
          renderCanvas();
        }
      } else if (msg.type === 'highlight') {
        highlightCard(msg.id);
      }
    } catch (err) {
      console.error('Invalid WS message:', event.data, err);
    }
  });

  socket.addEventListener('close', () => {
    setStatus('Reconnecting...', 'error');
    reconnectTimeout = setTimeout(connectWebSocket, 1000);
  });

  socket.addEventListener('error', (err) => {
    console.error('WebSocket error:', err);
    setStatus('Connection error', 'error');
  });

  ws = socket;
}

function setStatus(text, cls) {
  const status = document.getElementById('status');
  status.textContent = text;
  status.className = cls || '';
}

// Status reflects the active filter so counts never look broken.
function liveStatus(suffix = '') {
  const total = diagrams.length;
  if (filterQuery || fileFilter !== 'all') {
    const shown = visibleDiagrams().length;
    return `${shown} of ${total} shown${suffix}`;
  }
  return `${total} diagram${total !== 1 ? 's' : ''}${suffix}`;
}

function updateStatusFromWs() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    setStatus(liveStatus(' (live)'), 'connected');
  }
}

// Diagrams that pass both the search query and the file view selection.
function visibleDiagrams() {
  return diagrams.filter((d) => {
    if (fileFilter === '__active' && activeFile && d.file !== activeFile) return false;
    if (fileFilter !== 'all' && fileFilter !== '__active' && d.file !== fileFilter) return false;
    if (filterQuery) {
      const hay = `title:${extractTitle(d.source)} type:${detectDiagramType(d.source)} file:${basename(d.file)} ${d.source}`;
      if (!hay.toLowerCase().includes(filterQuery)) return false;
    }
    return true;
  });
}

function ensureEmptyState() {
  if (canvas.querySelector('.empty-state')) return;
  const el = document.createElement('div');
  el.className = 'empty-state';
  el.innerHTML = `
    <h2>No diagrams found</h2>
    <p>Open a markdown file with mermaid blocks in Zed${fileFilter !== 'all' ? ' — or clear the file filter' : ''}.</p>
  `;
  canvas.appendChild(el);
}

// Apply .hidden + section emptiness for the current filters.
function refreshCardVisibility() {
  const visibleIds = new Set(visibleDiagrams().map((d) => d.id));
  canvas.querySelectorAll('.diagram-card').forEach((card) => {
    card.classList.toggle('hidden', !visibleIds.has(card.dataset.diagramId));
  });
  canvas.querySelectorAll('.file-section').forEach((section) => {
    const hasVisible = section.querySelector('.diagram-card:not(.hidden)');
    section.classList.toggle('section-empty', !hasVisible);
  });
}

// ---- Search / filter ----
const searchInput = document.getElementById('search');
let searchTimer = null;

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(applyFilter, 150);
});

function applyFilter() {
  filterQuery = (searchInput.value || '').trim().toLowerCase();
  renderCanvas();
}

// ---- File view selection ----
const fileFilterSelect = document.getElementById('file-filter');

fileFilterSelect.addEventListener('change', () => {
  fileFilter = fileFilterSelect.value;
  saveStore('mermaidView.fileFilter.v1', fileFilter);
  renderCanvas();
});

function refreshFileOptions() {
  const prev = fileFilter;
  const files = [...new Set(diagrams.map((d) => d.file))].sort((a, b) =>
    basename(a).localeCompare(basename(b))
  );
  fileFilterSelect.innerHTML = '';
  for (const [value, label] of [
    ['all', `All files (${files.length})`],
    ['__active', 'Active editor'],
  ]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    fileFilterSelect.appendChild(opt);
  }
  for (const uri of files) {
    const opt = document.createElement('option');
    opt.value = uri;
    opt.textContent = basename(uri);
    fileFilterSelect.appendChild(opt);
  }
  // Drop the stale selection if that file no longer exists.
  fileFilter = [...fileFilterSelect.options].some((o) => o.value === prev) ? prev : 'all';
  fileFilterSelect.value = fileFilter;
}

function sendToServer(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ---- Lazy rendering visibility ----
function ensureVisibilityObserver() {
  if (visibilityObserver) return;
  visibilityObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const card = entry.target;
      const id = card.dataset.diagramId;
      if (entry.isIntersecting) {
        visibleCards.add(id);
        const diagram = diagrams.find((d) => d.id === id);
        if (diagram) {
          scheduleRender(diagram);
        }
      } else {
        visibleCards.delete(id);
      }
    }
  }, {
    root: canvasContainer,
    rootMargin: '200px',
  });
}

// ---- Data handling ----
function scheduleDiagramsUpdate(current) {
  // Debounce the whole update batch
  if (renderTimers.has('_update')) {
    clearTimeout(renderTimers.get('_update'));
  }
  renderTimers.set('_update', setTimeout(() => {
    handleDiagramsUpdate(current);
    renderTimers.delete('_update');
  }, RENDER_DEBOUNCE_MS));
}

// ---- Data handling ----
function handleDiagramsUpdate(current) {
  const currentIds = new Set(current.map((d) => d.id));

  // Remove stale cards
  canvas.querySelectorAll('.diagram-card').forEach((card) => {
    if (!currentIds.has(card.dataset.diagramId)) {
      card.remove();
      renderCache.delete(card.dataset.diagramId);
      visibleCards.delete(card.dataset.diagramId);
    }
  });

  // Prune saved positions for diagrams that no longer exist.
  const removed = Object.keys(cardPositions).some((id) => !currentIds.has(id));
  for (const id of Object.keys(cardPositions)) {
    if (!currentIds.has(id)) delete cardPositions[id];
  }
  if (removed) saveLayout();

  diagrams = current;
  refreshFileOptions();
  renderCanvas();

  // Kick renders for cards in view (sections may have moved them).
  for (const diagram of diagrams) {
    if (visibleCards.has(diagram.id)) {
      scheduleRender(diagram);
    }
  }
}

function applySavedPosition(card, diagram) {
  const pos = cardPositions[diagram.id];
  if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
    card.style.position = 'absolute';
    card.style.left = `${pos.x}px`;
    card.style.top = `${pos.y}px`;
    card.style.margin = '0';
  }
}

function getCard(diagram) {
  const cardId = cardIdFor(diagram.id);
  return document.getElementById(cardId);
}

function cardIdFor(id) {
  return `card-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function scheduleRender(diagram) {
  const existing = renderTimers.get(diagram.id);
  if (existing) clearTimeout(existing);
  renderTimers.set(
    diagram.id,
    setTimeout(() => {
      renderDiagram(diagram);
      renderTimers.delete(diagram.id);
    }, RENDER_DEBOUNCE_MS)
  );
}

// ---- Diagram rendering ----
async function renderDiagram(diagram) {
  const card = getCard(diagram);
  if (!card) return;

  card.classList.add('card-rendering');
  const body = card.querySelector('.card-body');

  try {
    if (typeof mermaid === 'undefined') {
      body.innerHTML = '<p class="card-error">mermaid.js not loaded. Run scripts/vendor.sh to download it.</p>';
      card.classList.remove('card-rendering');
      return;
    }

    // Cache hit: identical content already rendered
    if (diagram.contentHash && renderCache.has(diagram.contentHash)) {
      body.innerHTML = renderCache.get(diagram.contentHash);
      card.classList.remove('error', 'card-rendering');
      return;
    }

    const renderId = `mermaid-${renderCounter++}`;
    const { svg } = await mermaid.render(renderId, diagram.source);

    if (diagram.contentHash) {
      renderCache.set(diagram.contentHash, svg);
    }

    body.innerHTML = svg;
    card.classList.remove('error', 'card-rendering');
  } catch (err) {
    const message = err.message || String(err);
    body.innerHTML = `<p class="card-error">${escapeHtml(message)}</p>`;
    card.classList.add('error');
    card.classList.remove('card-rendering');
    console.error(`Failed to render diagram ${diagram.id}:`, err);
  }
}

function createCard(diagram) {
  const card = document.createElement('div');
  card.className = 'diagram-card';
  card.id = cardIdFor(diagram.id);
  card.dataset.diagramId = diagram.id;
  card.title = 'Click to open source in Zed. Double-click to focus.';

  const title = extractTitle(diagram.source);
  const type = detectDiagramType(diagram.source);

  card.innerHTML = `
    <div class="card-header">
      <div class="card-title-wrap">
        <span class="card-title">${escapeHtml(title)}</span>
        <span class="card-badge">${type}</span>
      </div>
      <span class="card-meta">${escapeHtml(basename(diagram.file))}:${diagram.lineStart}-${diagram.lineEnd}</span>
    </div>
    <div class="card-body resizer-container">
      <diagram-content/>
      <div class="resizer-handle" title="Resize corner">☐</div>
    </div>
    <div class="card-footer">
      <button class="card-btn export-svg" title="Download SVG">SVG</button>
      <button class="card-btn export-png" title="Download PNG">PNG</button>
    </div>
  `;
  addResizeHandle(card.querySelector('.resizer-container'));

  card.addEventListener('mousedown', (e) => beginCardDrag(e, card, diagram));

  card.addEventListener('click', (e) => {
    if (Date.now() < cardClickSuppressUntil) return;
    if (e.target.closest('.card-footer')) return;
    sendToServer({ type: 'showDocument', id: diagram.id });
  });

  card.addEventListener('dblclick', (e) => {
    if (Date.now() < cardClickSuppressUntil) return;
    e.stopPropagation();
    focusCard(card, diagram);
  });

  card.querySelector('.export-svg').addEventListener('click', (e) => {
    e.stopPropagation();
    exportSvg(diagram, card);
  });
  card.querySelector('.export-png').addEventListener('click', (e) => {
    e.stopPropagation();
    exportPng(diagram, card);
  });

  return card;
}

function updateCardMeta(card, diagram) {
  const title = extractTitle(diagram.source);
  const type = detectDiagramType(diagram.source);

  card.querySelector('.card-title').textContent = title;
  card.querySelector('.card-badge').textContent = type;
  card.querySelector('.card-meta').textContent =
    `${basename(diagram.file)}:${diagram.lineStart}-${diagram.lineEnd}`;
}

function highlightCard(id) {
  const card = document.getElementById(cardIdFor(id));
  if (!card) return;
  card.classList.add('highlighted');
  card.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  setTimeout(() => card.classList.remove('highlighted'), 2000);
}

// ---- Export ----
function exportSvg(diagram, card) {
  const svg = card.querySelector('.card-body svg');
  if (!svg) return;
  const blob = new Blob([svg.outerHTML], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeFilename(diagram)}.svg`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportPng(diagram, card) {
  const svg = card.querySelector('.card-body svg');
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width || svg.viewBox.baseVal.width || 400));
  const height = Math.max(1, Math.floor(rect.height || svg.viewBox.baseVal.height || 300));

  const canvasEl = document.createElement('canvas');
  canvasEl.width = width;
  canvasEl.height = height;
  const ctx = canvasEl.getContext('2d');

  const svgData = new XMLSerializer().serializeToString(svg);
  const img = new Image();
  const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  img.onload = () => {
    ctx.drawImage(img, 0, 0, width, height);
    URL.revokeObjectURL(url);
    canvasEl.toBlob((pngBlob) => {
      if (!pngBlob) return;
      const pngUrl = URL.createObjectURL(pngBlob);
      const a = document.createElement('a');
      a.href = pngUrl;
      a.download = `${safeFilename(diagram)}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(pngUrl);
    });
  };
  img.src = url;
}

function safeFilename(diagram) {
  const title = extractTitle(diagram.source);
  const base = basename(diagram.file).replace(/\.[^.]+$/, '');
  return `${base}-${title}`.replace(/[^a-zA-Z0-9_-]+/g, '-').substring(0, 60);
}

// ---- Focus mode ----
let focusOverlay = null;

function focusCard(card, diagram) {
  if (focusOverlay) return;

  const overlay = document.createElement('div');
  overlay.className = 'focus-overlay';
  overlay.innerHTML = `
    <div class="focus-toolbar">
      <span class="focus-title">${escapeHtml(extractTitle(diagram.source))}</span>
      <div>
        <button class="focus-btn export-svg" id="focus-export-svg">SVG</button>
        <button class="focus-btn export-png" id="focus-export-png">PNG</button>
        <button class="focus-btn" id="focus-close">Close (Esc)</button>
      </div>
    </div>
    <div class="focus-body"></div>
  `;
  document.body.appendChild(overlay);
  focusOverlay = overlay;

  const focusBody = overlay.querySelector('.focus-body');
  focusBody.innerHTML = card.querySelector('.card-body').innerHTML;

  // Enable SVG pan/zoom inside the focused view
  const svg = focusBody.querySelector('svg');
  if (svg) enableSvgPanZoom(svg, focusBody);

  overlay.querySelector('#focus-close').addEventListener('click', closeFocus);
  overlay.querySelector('#focus-export-svg').addEventListener('click', () => exportSvg(diagram, card));
  overlay.querySelector('#focus-export-png').addEventListener('click', () => exportPng(diagram, card));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeFocus();
  });

  const escHandler = (e) => {
    if (e.key === 'Escape') closeFocus();
  };
  overlay._escHandler = escHandler;
  document.addEventListener('keydown', escHandler);
}

function closeFocus() {
  if (!focusOverlay) return;
  document.removeEventListener('keydown', focusOverlay._escHandler);
  focusOverlay.remove();
  focusOverlay = null;
}

// Simple SVG pan/zoom for focus mode
function enableSvgPanZoom(svg, container) {
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let dragging = false;
  let start = { x: 0, y: 0 };

  function apply() {
    svg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  svg.style.cursor = 'grab';
  svg.style.transformOrigin = '0 0';
  apply();

  svg.addEventListener('mousedown', (e) => {
    dragging = true;
    start = { x: e.clientX - tx, y: e.clientY - ty };
    svg.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    tx = e.clientX - start.x;
    ty = e.clientY - start.y;
    apply();
  });

  window.addEventListener('mouseup', () => {
    dragging = false;
    svg.style.cursor = 'grab';
  });

  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const rect = container.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const newScale = Math.max(0.1, Math.min(10, scale * delta));
    const ratio = newScale / scale;
    tx = mx - ratio * (mx - tx);
    ty = my - ratio * (my - ty);
    scale = newScale;
    apply();
  }, { passive: false });
}

// ---- Diagram source helpers ----
function extractTitle(source) {
  const lines = source.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('%%{') && !trimmed.startsWith('%%')) {
      return trimmed.split(/\s+/)[0] || 'Diagram';
    }
  }
  return 'Diagram';
}

function detectDiagramType(source) {
  const firstLine = source.trim().split('\n')[0].trim();
  const match = firstLine.match(/^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|journey|gitGraph|mindmap|quadrantChart|xychart|timeline|requirementDiagram|C4Context|sankey|block-beta|architecture|packet|kanban|zenuml)/i);
  if (match) {
    const type = match[1];
    return type === 'graph' ? 'graph' :
           type === 'flowchart' ? 'flowchart' :
           type === 'sequenceDiagram' ? 'sequence' :
           type === 'classDiagram' ? 'class' :
           type === 'stateDiagram' ? 'state' :
           type === 'erDiagram' ? 'ER' :
           type === 'gantt' ? 'gantt' :
           type === 'pie' ? 'pie' :
           type === 'journey' ? 'journey' :
           type === 'gitGraph' ? 'git' :
           type === 'mindmap' ? 'mindmap' :
           type;
  }
  return 'unknown';
}

function basename(path) {
  return path.split('/').pop().split('\\').pop();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---- Fallback data fetch ----
async function fetchDiagramsFallback() {
  try {
    const resp = await fetch(`${SERVER}/api/diagrams`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.activeFile) activeFile = data.activeFile;
    return data.diagrams || [];
  } catch (err) {
    console.error('Failed to fetch diagrams:', err);
    return [];
  }
}

async function loadAndRender() {
  setStatus('Loading diagrams...', '');
  const initial = await fetchDiagramsFallback();
  await handleDiagramsUpdate(initial);
}

// ---- Presentation mode ----
let presentState = null; // { list, i, overlay, body, title, counter }

const presentBtn = document.getElementById('btn-present');
presentBtn.addEventListener('click', () => startPresentation());

function startPresentation() {
  const list = visibleDiagrams();
  if (list.length === 0) return;
  if (presentState) return;

  const overlay = document.createElement('div');
  overlay.className = 'present-overlay';
  overlay.innerHTML = `
    <div class="present-toolbar">
      <span class="present-title"></span>
      <span class="present-counter"></span>
      <div class="present-controls">
        <button class="present-btn" id="present-prev" title="Previous (←)">← Prev</button>
        <button class="present-btn" id="present-next" title="Next (→)">Next →</button>
        <button class="present-btn" id="present-close" title="Exit (Esc)">Close (Esc)</button>
      </div>
    </div>
    <div class="present-body"></div>
    <div class="present-hint">← / → to navigate · Esc to exit · double-click diagram for pan/zoom</div>
  `;
  document.body.appendChild(overlay);

  presentState = {
    list,
    i: 0,
    overlay,
    body: overlay.querySelector('.present-body'),
    title: overlay.querySelector('.present-title'),
    counter: overlay.querySelector('.present-counter'),
  };

  overlay.querySelector('#present-prev').addEventListener('click', () => presentStep(-1));
  overlay.querySelector('#present-next').addEventListener('click', () => presentStep(1));
  overlay.querySelector('#present-close').addEventListener('click', closePresentation);

  renderPresentSlide();
}

async function renderPresentSlide() {
  const st = presentState;
  if (!st) return;
  const diagram = st.list[st.i];
  if (!diagram) {
    closePresentation();
    return;
  }
  st.title.textContent = extractTitle(diagram.source);
  st.counter.textContent = `${st.i + 1} / ${st.list.length}`;
  st.body.innerHTML = '<div class="present-loading">rendering…</div>';

  try {
    let svg = null;
    // Reuse a rendered card body when we already have it.
    const card = getCard(diagram);
    const cardSvg = card && card.querySelector('.card-body svg');
    if (cardSvg) {
      svg = cardSvg.outerHTML;
    } else {
      const result = await mermaid.render(`present-${renderCounter++}`, diagram.source);
      svg = result.svg;
      if (diagram.contentHash) renderCache.set(diagram.contentHash, svg);
    }
    // Slide may have changed while rendering.
    if (!presentState || presentState.list[presentState.i] !== diagram) return;
    st.body.innerHTML = svg;
    const el = st.body.querySelector('svg');
    if (el) enableSvgPanZoom(el, st.body);
  } catch (err) {
    st.body.innerHTML = `<p class="card-error">${escapeHtml(err.message || String(err))}</p>`;
  }
}

function presentStep(delta) {
  const st = presentState;
  if (!st) return;
  st.i = Math.min(st.list.length - 1, Math.max(0, st.i + delta));
  renderPresentSlide();
}

function closePresentation() {
  if (!presentState) return;
  document.removeEventListener('keydown', presentState._keys);
  presentState.overlay.remove();
  presentState = null;
}

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
  fileFilter = loadStore('mermaidView.fileFilter.v1', 'all');
  if (fileFilter === '__active') {
    // Falls back gracefully if the server hasn't set an active file yet.
    fileFilterSelect.value = fileFilter;
  }
  applyTheme('dark');
  initMermaid();
  loadAndRender();
  connectWebSocket();
});

// ---- New: Import panel and locked positions setup ----
let importPanel = null;
// Locked positions are now automatically saved on drag - they persist indefinitely unless resetLayout() is called

// ---- Import panel initialization ----
const importPanelEl = document.getElementById('import-panel');
if (importPanelEl) {
  importPanel = importPanelEl;
  
  // Wire up toolbar Import button
  const btnImport = document.getElementById('btn-import');
  if (btnImport) {
    btnImport.addEventListener('click', toggleImportPanel);
  }
  
  // Add button inside panel - always enabled, renders on click
  const btnAdd = document.getElementById('import-add');
  if (btnAdd) {
    btnAdd.addEventListener('click', () => addImportedDiagram());
  }
  
  // Toggle on panel click
  if (importPanelEl) {
    importPanelEl.addEventListener('click', (e) => {
      if (e.target === importPanelEl || e.target.id === 'import-close') {
        toggleImportPanel();
      }
    });
  }
}

// ---- Function to add imported diagram ----
function addImportedDiagram() {
  const mermaidCode = document.getElementById('import-mermaid').value.trim();
  if (!mermaidCode) {
    alert('Please enter Mermaid code first.');
    return;
  }

  // Create a unique diagram ID for the imported diagram
  const tempFile = `imported-diagram-tmp:${Date.now()}`;
  const lineStart = 1;
  const lineEnd = mermaidCode.split('\n').length;
  
  // Use content hash as identifier to avoid conflicts
  const diagramId = tempFile + ':' + Math.random().toString(36).substr(2, 9);
  
  console.warn('[IMPORT] Importing temporary Mermaid diagram (will be lost on page reload)');

  // Create diagram object
  const newDiagram = {
    id: diagramId,
    file: tempFile,
    source: mermaidCode,
    lineStart: lineStart,
    lineEnd: lineEnd,
    __isTemporary: true, // Mark as temporary import
  };

  // Add to diagrams collection
  diagrams.push(newDiagram);

  // Clear textarea and close panel
  document.getElementById('import-mermaid').value = '';
  toggleImportPanel();

  // Render the new diagram
  const card = getCard(newDiagram);
  if (card) {
    applySavedPosition(card, newDiagram);
    ensureCard(newDiagram);
  }
}

// ---- Toggle import panel visibility ----
function toggleImportPanel() {
  if (!importPanelEl) return;
  
  // Show/hide the import panel
  importPanelEl.style.display = importPanelEl.style.display === 'none' ? 'block' : 'none';
  
  // Update status when panel is open
  const status = document.getElementById('status');
  if (importPanelEl.style.display === 'block') {
    status.textContent = 'Importing...';
  }
}

// Right-click context menu handler for canvas
if (document.getElementById('canvas')) {
  canvas.addEventListener('contextmenu', (e) => {
    // Only prevent default if not dragging and in free layout mode
    if (!isDragging && !arrangeMode) {
      e.preventDefault();
      if (importPanelEl) toggleImportPanel();
    }
  });
}

// ---- File Open support ----
document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('canvas');
  if (!canvas || !document.getElementById('toolbar')) return;
  
  // Add "Open Files" button after Layout button
  const toolbar = document.getElementById('toolbar');
  const layoutBtn = toolbar.querySelector('#btn-reset-layout');
  if (layoutBtn) {
    const fileBtn = document.createElement('button');
    fileBtn.id = 'btn-open-files';
    fileBtn.className = 'controls-btn';
    fileBtn.textContent = '📂 Open Files...';
    fileBtn.style.marginLeft = '8px';
    
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.md,.markdown,.mdx,.mmd';
    input.style.display = 'none';
    
    fileBtn.onclick = () => input.click();
    
    input.onchange = (e) => {
      const files = Array.from(e.target.files);
      if (!files.length) return;
      
      console.log('[OPEN] Loading files:', files.map(f => f.name));
      
      // Read and add all dropped files
      Promise.all(files.map(readFile)).then(diagrams => {
        diagrams.forEach(d => {
          if (d && !diagrams.find(existing => existing.id === d.id)) {
            const card = getCard(d);
            if (card) {
              applySavedPosition(card, d);
              ensureCard(d);
            }
          }
        });
      }).catch(err => {
        console.error('[OPEN] Error loading files:', err.message);
      });
    };
    
    toolbar.appendChild(fileBtn);
  }
});

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        // Extract mermaid blocks and add diagrams
        const matchers = [
          [/```mermaid(.*?)```/gs, 'mermaid'],
          [/~~~\s*mermaid(.*?)~~~/gs, 'mermaid'],
        ];
        
        let foundAny = false;
        for (const [regex, type] of matchers) {
          let match;
          while ((match = regex.exec(e.target.result)) !== null) {
            const content = match[1]?.trim();
            if (!content) continue;
            
            const lineNum = e.target.result.slice(0, match.index).split('\n').length;
            const tempFile = file.name + ':open:' + Date.now();
            const diagramId = `${tempFile}:${lineNum}`;
            
            const newDiagram = {
              id: diagramId,
              file: file.name,
              source: content,
              lineStart: lineNum,
              lineEnd: lineNum + (content.split('\n').length - 1),
              __isLoadedFrom: true,
            };
            
            diagrams.push(newDiagram);
            foundAny = true;
          }
        }
        
        if (!foundAny) {
          console.log('[OPEN] No mermaid blocks found in:', file.name);
        }
        
        resolve([e.target.result]);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

function dropFilesOnCanvas() {
  const canvas = document.getElementById('canvas');
  if (!canvas) return;
  
  // Allow dropping files on canvas
  ['dragover', 'dragleave', 'drop'].forEach(evt => {
    canvas.addEventListener(evt, handleDropEvent);
  });
}

function handleDropEvent(e) {
  e.preventDefault();
  
  // Get dropped files
  const files = Array.from(e.dataTransfer.files);
  
  // Filter for markdown/mermaid files
  const mdFiles = files.filter(file => 
    file.name.match(/\.(md|markdown|mdx|mmd)$/i)
  );
  
  if (mdFiles.length === 0) return;
  
  // Read first dropped file and add as diagrams
  readAndAddDroppedFile(mdFiles[0]);
}

async function readAndAddDroppedFile(file) {
  try {
    const text = await file.text();
    console.log('[DROP] File dropped:', file.name);
    
    // Extract mermaid code blocks
    const matchers = [
      [/```mermaid(.*?)```/gs, 'mermaid'],
      [/~~~\s*mermaid(.*?)~~~/gs, 'mermaid'],
      [/```graph(.*?)```/gs, 'graph'],
      [/~~~\s*(sequence|class|state)(.*?)~~~/gs, 'mmd'],
    ];
    
    for (const [regex, type] of matchers) {
      let match;
      while ((match = regex.exec(text)) !== null) {
        const fullMatch = match[0];
        const content = fullMatch.replace(/^```mermaid|~~~\s*mermaid|^\s*(sequence|graph|classDiagram)/i, '').trim();
        
        // Create diagram ID based on filename and line number
        const lineNum = text.slice(0, match.index).split('\n').length;
        const tempFile = file.name + ':drop:' + Date.now();
        const diagramId = `${tempFile}:${lineNum}`;
        
        // Create diagram object
        const newDiagram = {
          id: diagramId,
          file: file.name,
          source: content,
          lineStart: lineNum,
          lineEnd: lineNum + (content.split('\n').length - 1),
          __isDropped: true, // Mark as dropped file
        };
        
        console.log('[DROP] Adding diagram:', diagramId);
        
        // Add to collection
        diagrams.push(newDiagram);
        
        // Render
        const card = getCard(newDiagram);
        if (card) {
          applySavedPosition(card, newDiagram);
          ensureCard(newDiagram);
        }
      }
    }
  } catch (err) {
    console.error('[DROP] Error reading file:', err.message);
  }
}

// ---- Card resize handle ----
function addResizeHandle(container) {
  // Find existing resize button to avoid duplicates
  if (container.querySelector('.resizer-handle')) return;
  
  const resizer = document.createElement('div');
  resizer.className = 'resizer-handle';
  resizer.title = 'Resize corner';
  
  // Double-click anywhere on card to resize - simpler UX
  container.addEventListener('dblclick', (e) => {
    if (e.target.closest('.resizer-handle')) return;
    startResizing(container);
  });
  
  container.appendChild(resizer);
}

function startResizing(cardContainer) {
  const currentWidth = cardContainer.offsetWidth;
  const currentHeight = cardContainer.offsetHeight;
  let isResizing = false;
  
  document.addEventListener('mousedown', (e) => {
    if (!isResizing || e.target !== cardContainer) return;
    isResizing = true;
  });
  
  const handleMove = (e) => {
    if (!isResizing) return;
    
    const rect = cardContainer.getBoundingClientRect();
    const newWidth = Math.max(200, e.clientX - rect.left);
    const newHeight = Math.max(150, e.clientY - rect.top);
    
    // Apply new size
    Object.assign(cardContainer.style, {
      width: `${newWidth}px`,
      height: `${newHeight}px`,
    });
  };
  
  const handleUp = () => {
    if (!isResizing) return;
    isResizing = false;
    document.removeEventListener('mousemove', handleMove);
    document.removeEventListener('mouseup', handleUp);
  };
  
  cardContainer.addEventListener('dblclick', (e) => {
    if (e.target.closest('.resizer-handle')) return;
    const rect = cardContainer.getBoundingClientRect();
    isResizing = true;
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
  });
}
