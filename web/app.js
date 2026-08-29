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
let cardPositions = loadStore(LAYOUT_KEY, {}); // diagram id → {x, y} in canvas coords

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

  // Promote the grid item to an absolutely positioned card anchored at its
  // current spot, so the rest of the flow doesn't jump while dragging.
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
  canvas
    .querySelectorAll('.diagram-card')
    .forEach((card) => {
      card.style.position = '';
      card.style.left = '';
      card.style.top = '';
      card.style.margin = '';
    });
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
  if (e.key === 'f' || e.key === 'F') fitAll();
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
  if (filterQuery) {
    const shown = canvas.querySelectorAll('.diagram-card:not(.hidden)').length;
    return `${shown} of ${total} shown${suffix}`;
  }
  return `${total} diagram${total !== 1 ? 's' : ''}${suffix}`;
}

// ---- Search / filter ----
const searchInput = document.getElementById('search');

searchInput.addEventListener('input', applyFilter);

function applyFilter() {
  filterQuery = (searchInput.value || '').trim().toLowerCase();
  const cards = canvas.querySelectorAll('.diagram-card');
  for (const card of cards) {
    const diagram = diagrams.find((d) => d.id === card.dataset.diagramId);
    const hay = diagram
      ? `title:${extractTitle(diagram.source)} type:${detectDiagramType(diagram.source)} file:${basename(diagram.file)} ${diagram.source}`
      : '';
    card.classList.toggle('hidden', Boolean(filterQuery) && !hay.toLowerCase().includes(filterQuery));
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    setStatus(liveStatus(' (live)'), 'connected');
  }
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
  for (const id of Object.keys(cardPositions)) {
    if (!currentIds.has(id)) delete cardPositions[id];
  }
  saveLayout();

  diagrams = current;

  // Remove leftover empty-state message once real diagrams exist.
  const emptyState = canvas.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  // Create/update cards and schedule renders
  for (const diagram of current) {
    ensureCardExists(diagram);
    updateCardMeta(getCard(diagram), diagram);
    if (visibleCards.has(diagram.id)) {
      scheduleRender(diagram);
    }
  }

  applyFilter();

  if (current.length === 0) {
    canvas.innerHTML = `
      <div class="empty-state">
        <h2>No diagrams found</h2>
        <p>Open a markdown file with mermaid blocks in Zed.</p>
      </div>
    `;
  }
}

function ensureCardExists(diagram) {
  if (getCard(diagram)) return;
  const card = createCard(diagram);
  canvas.appendChild(card);
  applySavedPosition(card, diagram);
  ensureVisibilityObserver();
  visibilityObserver.observe(card);
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
    <div class="card-body"></div>
    <div class="card-footer">
      <button class="card-btn export-svg" title="Download SVG">SVG</button>
      <button class="card-btn export-png" title="Download PNG">PNG</button>
    </div>
  `;

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

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
  applyTheme('dark');
  initMermaid();
  loadAndRender();
  connectWebSocket();
});
