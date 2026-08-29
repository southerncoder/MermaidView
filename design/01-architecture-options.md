# Architecture: MermaidView — Diagram Workspace for Zed

## Vision

A Mermaid diagram workspace that renders all diagrams from your files
on a single zoomable canvas, with live updates as you edit, and full
pan/zoom on individual diagrams. Powered by mermaid.js in the browser —
no Node.js, no CLI, no document mutation.

## Core Principle

**The browser is the rendering engine.** Mermaid.js runs natively in the
browser, rendering SVG directly in the DOM. This gives us full spec
support, hardware-accelerated rendering, interactivity, and multiple
diagrams on one canvas — all for free.

## System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Zed Editor                          │
│                                                         │
│  ┌────────────┐    ┌─────────────────────────────┐      │
│  │  Markdown   │    │  Extension (cdylib)         │      │
│  │  Editor     │←─→│  src/lib.rs                 │      │
│  │  (.md/.mmd) │    │  - Register LSP server      │      │
│  └────────────┘    │  - Binary management        │      │
│                    │  - mmdc install (removed)    │      │
│                    └──────────┬──────────────────┘      │
│                               │                          │
└───────────────────────────────┼──────────────────────────┘
                                │ LSP protocol (JSON-RPC)
                                ▼
              ┌────────────────────────────────────┐
              │  MermaidView Server (Rust binary)   │
              │  server/src/                       │
              │                                    │
              │  ┌──────────┐  ┌────────────────┐  │
              │  │ LSP      │  │ HTTP Server    │  │
              │  │ Handler   │  │ (serves web app)│  │
              │  │           │  └────────────────┘  │
              │  │ - didOpen │  ┌────────────────┐  │
              │  │ - didChange│ │ WebSocket Srv  │  │
              │  │ - codeAction││ (live updates) │  │
              │  │ - showDoc │  └────────────────┘  │
              │  └──────────┘  ┌────────────────┐  │
              │  │ Diagram    │  │ Mermaid block   │  │
              │  │ Registry   │  │ extraction      │  │
              │  │             │  │ (regex parser)  │  │
              │  └──────────┘  └────────────────┘  │
              └────────────────┬───────────────────┘
                               │ HTTP + WebSocket
                               ▼
         ┌──────────────────────────────────────────┐
         │         Browser (Canvas Web App)          │
         │         web/                              │
         │                                          │
         │  ┌──────────────────────────────────┐    │
         │  │  Zoomable Canvas                  │    │
         │  │  ┌────┐ ┌────┐ ┌────┐            │    │
         │  │  │ D1 │ │ D2 │ │ D3 │  ...       │    │
         │  │  └────┘ └────┘ └────┘            │    │
         │  │  (pan/zoom on canvas)            │    │
         │  └──────────────────────────────────┘    │
         │                                          │
         │  - mermaid.js (vendored, ESM)            │
         │  - Diagram cards (rendered SVGs)         │
         │  - Per-diagram pan/zoom (svg-pan-zoom)   │
         │  - WebSocket client (live updates)       │
         │  - Theme matching (light/dark)           │
         └──────────────────────────────────────────┘
```

## Component Design

### 1. Extension (`src/lib.rs`)

Thin shim. Responsibilities:
- Register the MermaidView LSP server with Zed
- Download/cache the server binary from GitHub releases
- Report installation status
- No rendering logic here at all

### 2. MermaidView Server (`server/src/`)

Rust binary that runs as the LSP server. Has three jobs:

#### a. LSP Handler (`server/src/lsp.rs`)
- Track open documents (didOpen, didChange, didClose)
- Extract mermaid blocks from markdown (regex-based fence parser)
- Provide code actions: "Open Diagram Workspace", "Copy Diagram SVG"
- Respond to `window/showDocument` (navigate to source location)

#### b. Diagram Registry (`server/src/registry.rs`)
- Maintains a live registry of all diagrams across open documents
- Each diagram has: id, source text, file path, line range, content hash
- Notifies subscribers (WebSocket clients) on changes
- Debounces rapid edits (configurable, default 200ms)

#### c. HTTP/WebSocket Server (`server/src/server.rs`)
- Serves the web app (HTML/JS/CSS) at `http://127.0.0.1:PORT/`
- REST endpoints:
  - `GET /` → Canvas web app
  - `GET /api/diagrams` → JSON list of all diagrams
  - `GET /api/diagrams/:id` → Diagram metadata + source
- WebSocket endpoint:
  - `WS /ws` → Pushes diagram add/update/remove events
  - Client sends: `{ type: "click", diagramId: "..." }` for navigation

### 3. Canvas Web App (`web/`)

The heart of the product. A web application that:

#### a. Loads mermaid.js
- Vendored ESM module (no CDN dependency, works offline)
- Pinned version for reproducibility
- Initialized with theme config

#### b. Renders the Canvas
- Infinite zoomable canvas (CSS transform-based)
- Diagram cards arranged in a responsive grid
- Each card contains a rendered SVG from mermaid.js
- Cards show: diagram title (from first line), type, source file, line range

#### c. Pan/Zoom
Two levels:
- **Canvas-level:** Pan between cards, zoom out to see all, zoom in to focus
  - Implemented via CSS transforms on the canvas container
  - Mouse wheel, drag, pinch, keyboard arrows
- **Diagram-level:** When a card is focused/expanded, pan/zoom within the SVG
  - Implemented via `svg-pan-zoom` or `panzoom` library
  - Independent of canvas pan/zoom

#### d. Live Updates
- WebSocket connection to server
- On diagram update event: re-render that card via `mermaid.render()`
- Preserve canvas position/zoom state across updates
- Show loading indicator during re-render

#### e. Navigation
- Click a card → sends message via WebSocket → server sends `window/showDocument`
  to Zed → Zed navigates to that diagram's source location
- This creates a bidirectional link between canvas and editor

## Data Flow

### Initial Load

```
1. User opens markdown file with mermaid blocks in Zed
2. LSP receives textDocument/didOpen
3. Server extracts all mermaid blocks → Diagram Registry
4. User triggers "Open Diagram Workspace" (code action)
5. Server starts HTTP server (if not already running)
6. Server opens browser to http://127.0.0.1:PORT/
7. Browser loads web app
8. Web app fetches /api/diagrams → gets all diagrams
9. Web app renders each diagram via mermaid.js
10. Canvas displays all diagram cards
11. WebSocket connection established
```

### Live Editing

```
1. User edits a mermaid block in Zed
2. LSP receives textDocument/didChange
3. Server re-extracts blocks → updates Diagram Registry
4. Server detects changed diagram (content hash mismatch)
5. Server pushes WebSocket event: { type: "update", diagramId, source }
6. Web app receives update
7. Web app calls mermaid.render() with new source
8. Card SVG updated in-place
9. Pan/zoom state preserved
```

### Click-to-Source Navigation

```
1. User clicks a diagram card in browser
2. Web app sends WebSocket message: { type: "navigate", diagramId }
3. Server receives message
4. Server sends LSP window/showDocument request to Zed
5. Zed navigates to the diagram's file and line range
6. Diagram source is highlighted in editor
```

## Security

- HTTP server binds to `127.0.0.1` only (no remote access)
- No authentication needed (localhost only)
- mermaid.js renders in browser sandbox
- No file system access from the web app
- Server only serves its own web app (no arbitrary file serving)

## Theme Integration

The server detects Zed's theme via LSP configuration notifications and
pushes it to the web app via WebSocket. The web app applies matching
CSS variables (background, foreground, accent colors).

If theme info isn't available, falls back to `prefers-color-scheme`.

## Growth Path

### When Zed Adds Webview/Preview Panel API
- Embed the same `web/` app inside Zed as a native panel
- No architecture change needed — just a different container
- The Rust server and web app stay the same
- Only the "open in browser" part becomes "open in Zed panel"

### Standalone Mode
- The web app could work standalone (point it at a folder of .md files)
- Server could run as a CLI: `mermaidview ./docs/`
- Opens browser with all diagrams from that folder

### Additional Diagram Types
- mermaid.js supports all diagram types — we get them for free
- Could also support PlantUML, Graphviz, etc. by adding renderers
- The canvas concept works for any visual content

## File Structure (Revised)

```
MermaidView/
├── extension.toml           # Zed extension metadata
├── Cargo.toml               # Workspace root
├── src/
│   └── lib.rs               # Extension entry point (cdylib)
├── server/                  # MermaidView server (Rust binary)
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs          # Entry point, starts LSP + HTTP
│       ├── lsp.rs           # LSP protocol handler
│       ├── registry.rs      # Diagram registry + change tracking
│       ├── server.rs        # HTTP + WebSocket server
│       └── extract.rs       # Mermaid block extraction from markdown
├── web/                     # Canvas web application
│   ├── index.html           # Entry point
│   ├── app.js               # Main application logic (ESM)
│   ├── canvas.js            # Zoomable canvas component
│   ├── card.js              # Diagram card component
│   ├── ws-client.js         # WebSocket client
│   ├── mermaid/             # Vendored mermaid.js (ESM)
│   ├── vendor/              # Vendored libraries (svg-pan-zoom, etc.)
│   └── styles.css           # Theme-aware styles
├── languages/
│   └── mermaid/
│       └── config.toml      # Mermaid language config
├── plan/                    # Planning documents
├── design/                  # Design documents
├── scripts/
│   ├── build.sh             # Build extension + server
│   ├── install.sh           # Install as Zed dev extension
│   └── vendor.sh           # Download/vendor mermaid.js + libs
└── README.md
```