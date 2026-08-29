# Development Roadmap (Revised)

## Vision

MermaidView is a **Mermaid Diagram Workspace** for the Zed editor.
It renders all mermaid diagrams from your files on a single zoomable
canvas, with live updates as you edit, and full pan/zoom on individual
diagrams. No Node.js required — powered by mermaid.js running directly
in the browser.

## Phase 1: Core Pipeline — Single Diagram Live Preview

**Goal:** Prove the full pipeline: Zed → LSP → HTTP/WS → Browser →
mermaid.js rendering. Start with a single diagram, live updates.

**Tasks:**

- [x] **Extension (`src/lib.rs`)**
  - `extension.toml` with LSP registration
  - Extension entry point: register server, resolve binary path
  - Binary resolution: local build → PATH → GitHub release (placeholder)

- [x] **Server — LSP Handler (`server/src/lsp.rs`)**
  - LSP protocol handshake (initialize, initialized)
  - Document tracking (didOpen, didChange, didClose)
  - Mermaid block extraction (```mermaid fence parser)
  - Code action: "Open Diagram Workspace"
  - Execute command handler: `mermaidView.openWorkspace`

- [x] **Server — Diagram Registry (`server/src/registry.rs`)**
  - Store diagrams: id, source, file, line range, hash
  - Detect changes (hash comparison)

- [x] **Server — HTTP/WebSocket (`server/src/server.rs`)**
  - Bind to 127.0.0.1, random port
  - Serve static web app files
  - `GET /api/diagrams` → JSON list
  - WebSocket upgrade on any route (detects `Upgrade: websocket`)
  - Push `init` and `update` events to browser
  - Run HTTP server in background thread alongside LSP

- [x] **Web App — Minimal Canvas (`web/`)**
  - Vendor mermaid.js (global script)
  - `index.html` + `app.js`
  - Fetch diagrams from `/api/diagrams` (fallback)
  - Render single diagram via `mermaid.render()`
  - WebSocket client for live updates
  - Basic CSS (full-screen SVG, dark theme)

- [x] **Integration**
  - Code action opens browser via OS command
  - Edit in Zed → diagram updates in browser
  - Build scripts (`scripts/build.sh`, `scripts/install.sh`, `scripts/install.ps1`)

**Deliverable:** Open a markdown file in Zed → trigger workspace →
browser shows the diagram → edit in Zed → diagram updates live.

---

## Phase 2: Multi-Diagram Canvas

**Goal:** Show ALL diagrams from a file on one zoomable canvas with
gallery layout and per-diagram pan/zoom.

**Tasks:**

- [x] **Canvas pan/zoom**
  - CSS transform-based pan/zoom on canvas container
  - Mouse wheel zoom, drag pan, keyboard navigation
  - Fit-all and reset controls

- [x] **Diagram Card Component**
  - Card layout: header (title, type, file, lines) + SVG body
  - Card sizing: fit SVG to card width, maintain aspect ratio
  - Hover state: border highlight
  - Error state: show parse errors with context

- [x] **Gallery Layout**
  - Responsive CSS grid based on viewport width

- [x] **Focus Mode**
  - Double-click card → expand to full viewport
  - SVG pan/zoom inside focused card (native JS implementation)
  - Esc to exit, preserves canvas position

- [x] **Multi-diagram Server Support**
  - Registry tracks all diagrams across all open files
  - WebSocket events: `init`, `update`
  - API: `GET /api/diagrams` returns all diagrams

- [x] **Click-to-Source Navigation (early)**
  - Click card in browser → WebSocket `showDocument` → server →
    `window/showDocument` request to Zed

**Deliverable:** All diagrams from open files displayed as cards on a
zoomable canvas. Click to open source in Zed. Double-click to focus
with pan/zoom. Live updates.

---

## Phase 3: Navigation & Polish

**Goal:** Bidirectional navigation between canvas and editor. Production
quality.

**Tasks:**
- [x] **Click-to-Source Navigation**
  - Click card in browser → WebSocket `showDocument` → server →
    `window/showDocument` request to Zed → navigate to source

- [x] **Source-to-Diagram Highlight**
  - Code action "Highlight Diagram in Workspace" when cursor is inside a block
  - Highlights the corresponding card in the browser

- [x] **Rendering Performance**
  - Lazy rendering: only render visible cards (IntersectionObserver, 200px buffer)
  - Debounced re-render (200ms)
  - Caching: mermaid.js render results by content hash

- [x] **Error Handling & UX**
  - mermaid.js parse errors shown in card (red border, message)
  - Browser connection lost → auto-reconnect WebSocket

- [x] **Theme Integration**
  - LSP handles `workspace/didChangeConfiguration`
  - Pushes `theme` message via WebSocket
  - Light/dark CSS variables applied to document
  - Mermaid theme config updated

- [x] **Export**
  - Download individual diagram as SVG
  - Download individual diagram as PNG (canvas-based)

- [ ] **Zed settings schema**
  - Register `mermaidView.theme` setting so users can override
  - Document in README

- [ ] **Port fallback / error UX**
  - Port already in use → find alternative port
  - Surface server start failures to Zed

**Deliverable:** Click a diagram → Zed jumps to source. Cursor in
source → run "Highlight Diagram in Workspace" to focus the card.
Smooth performance. Themed. Export ready.

---

## Phase 4: Advanced Features

**Goal:** Make MermaidView a genuinely indispensable tool.

**Tasks:**

- [x] **Multi-File Workspace View**
  - Show diagrams from all open files, grouped by file
  - Section headers per file
  - Toggle: current file only / all open files / entire workspace

- [ ] **Manual Layout**
  - Drag cards to custom positions
  - Persist layout (localStorage or server-side)
  - Lock positions to prevent auto-arrange

- [ ] **Standalone Mode**
  - Run server as CLI: `mermaidview ./docs/`
  - Watches folder for changes
  - Opens browser with all diagrams from folder
  - Works without Zed (any editor)

- [ ] **Search & Filter**
  - Search diagrams by name, type, or content
  - Filter by diagram type (flowchart, sequence, etc.)
  - Filter by source file

- [ ] **Manual Layout**
  - Drag cards to custom positions
  - Persist layout (localStorage or server-side)
  - Lock positions to prevent auto-arrange

- [ ] **Presentation Mode**
  - Full-screen, one diagram at a time
  - Arrow keys to navigate
  - Clean background, no UI chrome
  - Optional: auto-advance timer

- [ ] **Diagram Annotations**
  - Add notes/markers on the canvas (future)
  - Link between diagrams (arrows/connections)

- [ ] **Additional Renderers**
  - PlantUML support
  - Graphviz/DOT support
  - Excalidraw raw files
  - All share the same canvas

- [ ] **Zed Webview Integration (when available)**
  - Embed web app as native Zed panel
  - No external browser needed
  - Same codebase, different container

**Deliverable:** A full-featured diagram workspace with search,
presentation mode, standalone CLI, and multi-format support.

---

## Milestone Summary

| Phase | Goal | Key Feature |
|-------|------|-------------|
| 1 | Core pipeline | Single diagram, live preview in browser |
| 2 | Multi-diagram | All diagrams on zoomable canvas, gallery + focus |
| 3 | Navigation | Click-to-source, source-to-diagram, polish |
| 4 | Advanced | Multi-file, standalone, search, presentation, more formats |

## Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|----------|
| Rendering engine | mermaid.js in browser | Native environment, full spec, no deps |
| Node.js | Not required | Browser runs mermaid.js directly |
| Server language | Rust | Matches Zed ecosystem, performance, safety |
| Web app framework | Vanilla JS (global script) | Minimal deps, fast load, easy to vendor |
| Pan/zoom (canvas) | CSS transforms | Hardware-accelerated, simple |
| Pan/zoom (diagram) | Native JS SVG transform | No extra vendored library |
| WebSocket | tungstenite (sync) + manual handshake | No async runtime refactor needed |
| Mermaid.js | Vendored global script | Offline, version-pinned, no CDN |
| Document mutation | None | Source files stay clean |