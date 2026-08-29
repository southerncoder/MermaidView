# Research Findings: MermaidView — Diagram Workspace for Zed

## Date: 2026-08-28 (revised)

## 1. The Key Insight

The existing Zed mermaid plugin (`wfukatsu/zed-mermaid-plugin`) renders
diagrams via `mmdc` CLI (Node.js) and inserts SVG into the markdown
document. This has problems: requires Node.js, mutates the document, no
interactivity, one diagram at a time.

**The critical realization:** If the preview is going to be in a browser
anyway (for pan/zoom), then the browser should run mermaid.js directly.
The browser IS the rendering engine. No CLI, no Node.js, no process
spawning. This is exactly how mermaid.live works — it's just a web app
that loads mermaid.js and renders in the browser.

## 2. Why Browser-Based mermaid.js Is the Best Rendering Engine

| Criterion | mmdc CLI (existing) | Rust-native | Embedded JS (boa) | Browser mermaid.js (ours) |
|-----------|---------------------|-------------|--------------------|-----------------------------|
| Full spec support | Yes (via mermaid.js) | No (partial) | Fragile (DOM polyfills) | Yes (native environment) |
| Node.js dependency | Required | None | None | None |
| Process spawn latency | 500ms-2s | N/A | N/A | None (in-browser) |
| Live re-render | Slow (respawn CLI) | Fast | Medium | Fast (mermaid.render()) |
| Interactivity | None | Custom-built | Complex | Free (browser APIs) |
| Multiple diagrams | Sequential | Possible | Possible | Natural (DOM) |
| Enormous diagrams | SVG output → display | Custom rendering | Uncertain | Hardware-accelerated SVG |
| Maintenance burden | Low (use mmdc) | Very high | High | Low (use mermaid.js) |
| Growth potential | Limited | High but slow | High | Very high |

**Decision: Browser-based mermaid.js.** It's the natural rendering engine
for mermaid. We get full spec support, interactivity, performance, and
growth potential — all for free.

## 3. Zed Extension API Constraints (unchanged)

The `zed_extension_api` supports:
- Language server registration and management
- Syntax/language configuration
- Theme support
- GitHub release downloads

It does NOT support:
- Custom UI panels or webviews (yet)
- Interactive canvas/SVG rendering
- Custom editor view types

**Impact:** Our canvas must run in an external browser for now. When Zed
adds a webview/preview panel API, the same web app can be embedded.

## 4. The "Multiple Diagrams on One Canvas" Concept

This is the core differentiator. Instead of rendering diagrams one at a
time inline in the document, we build a **Diagram Workspace** — a canvas
showing all mermaid diagrams from the current file (or workspace) at
once.

### What This Enables

- **Architecture overview:** See all diagrams in a doc/folder at a glance
- **Live editing:** Edit a diagram in Zed → see it update on the canvas
- **Comparison:** Multiple diagrams side by side
- **Navigation:** Click a diagram → jump to source in Zed
- **Presentation:** Zoom into diagrams during reviews

### Canvas Layout Modes

1. **Gallery mode:** Grid of diagram cards (thumbnails)
2. **Focus mode:** One diagram full-screen with pan/zoom
3. **Free canvas:** Drag diagrams to custom positions (future)

## 5. Mermaid.js Technical Details

### Version
- Mermaid v11+ is the current major version
- ESM-only (ES modules)
- Can be vendored or loaded from CDN
- Vendoring is better for offline use and version pinning

### Rendering API
```javascript
import mermaid from 'mermaid';

// Render a diagram
const { svg } = await mermaid.render('diagram-id', mermaidSource);
container.innerHTML = svg;
```

This is all we need. No CLI, no temp files, no process spawning.

### Pan/Zoom
- Use CSS transforms on the canvas container for canvas-level pan/zoom
- Use `svg-pan-zoom` or `panzoom` library for individual diagram pan/zoom
- Both are hardware-accelerated in browsers

## 6. Architecture (Revised)

```
┌─────────────────────────────────────────────────────┐
│                   Zed Editor                         │
│                                                      │
│  ┌──────────┐     ┌──────────────────────────┐       │
│  │ Markdown  │     │  Extension (cdylib)      │       │
│  │  Editor   │←──→│  src/lib.rs              │       │
│  │           │     │  - LSP registration      │       │
│  └──────────┘     └────────┬─────────────────┘       │
│                             │                         │
└─────────────────────────────┼─────────────────────────┘
                              │ LSP protocol
                              ▼
                 ┌──────────────────────────┐
                 │  MermaidView Server (Rust)│
                 │  server/src/             │
                 │                          │
                 │  - LSP handler           │
                 │  - Block extraction     │
                 │  - HTTP server          │
                 │  - WebSocket server     │
                 │  - Diagram registry     │
                 └────────┬───────────────┘
                          │ HTTP + WebSocket
                          ▼
              ┌──────────────────────┐
              │  Browser (Canvas App) │
              │  web/                 │
              │                      │
              │  - mermaid.js (vendored)│
              │  - Canvas with cards  │
              │  - Pan/zoom           │
              │  - Live WS updates    │
              │  - Theme-aware        │
              └──────────────────────┘
```

### No Document Mutation

The user's markdown files are never modified. Diagrams are extracted,
sent to the web app, and rendered in the browser. The source files
stay clean.

## 7. Comparison: Existing Plugin vs MermaidView

| Feature | Existing Plugin | MermaidView (ours) |
|---------|-----------------|---------------------|
| Rendering engine | mmdc CLI (Node.js) | mermaid.js in browser |
| Node.js required | Yes | No |
| Document mutation | Yes (inserts SVG) | No |
| Pan/zoom | None | Full (canvas + per-diagram) |
| Multiple diagrams | One at a time | All on one canvas |
| Live updates | Manual code action | Real-time via WebSocket |
| Large diagrams | SVG in document (bloats file) | Browser rendering (stays fast) |
| Editor integration | Inline SVG | Click-to-source navigation |
| Export | None | SVG/PNG download |
| Offline | Needs Node.js | Vendored mermaid.js (works offline) |
| Growth potential | Limited | High (web-based, extensible) |