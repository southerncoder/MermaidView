# MermaidView — Mermaid Diagram Workspace for Zed

A Zed editor extension that renders all your Mermaid diagrams on a
single zoomable canvas, with live updates as you edit. Powered by
mermaid.js running directly in the browser — no Node.js required.

## Quick Start

### 1. Build

```bash
# Build the extension + server
cargo build --release

# Download mermaid.js (~2.5MB)
sh scripts/vendor.sh
```

### 2. Install as dev extension

**macOS/Linux:**
```bash
sh scripts/install.sh
```

**Windows:**
```powershell
.\scripts\install.ps1
```

Then in Zed: `Ctrl+Shift+P` → "Extensions: Install Development Extension" → select the extension directory.

### 3. Use

1. Open a markdown file with `mermaid` code blocks in Zed
2. The server starts automatically and opens a browser
3. All diagrams appear on a zoomable canvas
4. Edit in Zed → diagrams update live via WebSocket

## Controls

| Input | Action |
|-------|--------|
| Drag empty canvas | Pan |
| Mouse wheel | Zoom |
| `F` | Fit all diagrams |
| `R` | Reset zoom/position |
| `+` / `-` | Zoom in/out |
| Double-click card | Focus mode (pan/zoom the SVG) |
| `Esc` | Exit focus mode |
| Hover card footer | Export SVG / PNG |

## Commands

With the cursor inside a `mermaid` block:

- **Open Diagram Workspace** — opens the browser canvas.
- **Highlight Diagram in Workspace** — highlights the corresponding card in the browser.

Click any card in the browser to jump back to its source in Zed.

## Settings

You can override the canvas theme in your Zed `settings.json`:

```json
{
  "mermaidView": {
    "theme": "light"
  }
}
```

Valid values: `"light"` or `"dark"`. The default is `"dark"`.

## Architecture

```
Zed Editor ←(LSP)→ Rust Server ←(HTTP)→ Browser Canvas
                         ↓
                   mermaid.js (in browser)
```

The browser runs mermaid.js directly — no Node.js, no CLI, no temp files.

## Status

🚧 **Phase 3: Navigation & Polish** — Core features complete, polishing remaining.

| Component | Status |
|-----------|--------|
| Extension (`src/`) | ✅ |
| Server LSP (`server/src/lsp.rs`) | ✅ |
| Server HTTP + WebSocket (`server/src/server.rs`) | ✅ |
| Diagram extraction (`server/src/extract.rs`) | ✅ + tests |
| Diagram registry (`server/src/registry.rs`) | ✅ + tests |
| Web app (`web/`) | ✅ |
| mermaid.js vendored | ✅ |
| Build/install scripts | ✅ |
| Live WebSocket updates | ✅ |
| Multi-diagram canvas + focus mode | ✅ |
| Click-to-source / source-to-diagram highlight | ✅ |
| Theme sync | ✅ |
| Export SVG/PNG | ✅ |
| Render debounce + cache | ✅ |

## Project Structure

```
MermaidView/
  src/lib.rs                # Zed extension entry point
  server/                   # Rust LSP + HTTP server
    src/
      main.rs               # Entry point
      lsp.rs                # LSP protocol handler
      server.rs             # HTTP server (static + REST API)
      extract.rs            # Mermaid block parser
      registry.rs           # Diagram tracking + change detection
  web/                      # Canvas web application
    index.html              # Entry page
    app.js                  # Canvas + rendering logic
    styles.css              # Theme-aware styles
    mermaid.min.js          # Vendored mermaid.js (run vendor.sh)
  plan/                     # Research and roadmap
  design/                   # Architecture documents
  scripts/
    build.sh                # Build extension + server
    install.sh              # Install as Zed dev extension (macOS/Linux)
    install.ps1             # Install as Zed dev extension (Windows)
    vendor.sh               # Download mermaid.js
```

## Development

```bash
# Build debug (fast)
cd server && cargo build

# Run tests
cd server && cargo test

# Run server standalone (for testing web app)
cargo run -p mermaid-view-server
```

The standalone server reads `web/` from the repository root. Open the URL it prints.

## License

MIT