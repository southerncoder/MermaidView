# MermaidView — Multi-Diagram Workspace for Zed

[![Zed Extension](https://img.shields.io/badge/Zed-v0.210.0+-blue?logo=zed&labelColor=333)
![Rust](https://img.shields.io/badge/Rust-1.75+-orange?logo=rust)
![License](https://img.shields.io/badge/license-MIT-blue.svg)

> **Render all your Mermaid diagrams on a single zoomable canvas with live updates.**

[![Status: Phase 3 - Navigation & Polish](https://img.shields.io/badge/status-Phase%203-green?style=for-the-badge)](#status)
[![No Node.js Required](https://img.shields.io/badge/dependencies-none--node--green?style=for-the-badge&color=success)](https://mermaid.github.io/)

A Zed editor extension that transforms your Mermaid diagrams into a powerful visual workspace. View, navigate, and present all your diagrams on a unified canvas with real-time sync as you edit. Powered by [mermaid.js](https://mermaid.js.org/) running directly in your browser — **zero Node.js dependencies**.

## ✨ Features

- **🎯 Unified Canvas**: See all Mermaid diagrams from your entire workspace on one scrollable surface
- **🔄 Live Updates**: Edit in Zed → diagrams update instantly via WebSocket (no refresh needed)
- **🚀 Pan & Zoom**: Navigate huge canvases with mouse wheel, drag-to-pan, or keyboard shortcuts
- **📁 File Grouping**: Organize diagrams by file with collapsible sections
- **🎨 Live Theme Sync**: Automatically matches Zed's light/dark theme
- **⌨️ Keyboard Shortcuts**
  - `/` — Focus search filter
  - `F` — Fit all diagrams to viewport
  - `R` — Reset zoom and position
  - `P` — Enter/exit presentation mode
  - Double-click card — Enter focus mode for diagram-level navigation
- **🖥️ Presentation Mode**: Full-screen slideshow (arrow keys to navigate)
- **🔗 Bi-directional Navigation**: Click any diagram → jump to source in Zed. Click source code → highlight diagram.
- **💾 Export**: Save diagrams as SVG or PNG from hover menu
- **📱 Standalone Mode**: Run without Zed for independent testing
- **⚡ Debounced Rendering**: Optimized for smooth updates even with many diagrams

## 📸 Screenshots

*(Add actual screenshots here when available)*

<table>
<tr>
<td><b>Main Canvas</b><br><br>Multi-diagram workspace showing all project diagrams grouped by file.</td>
<td><b>Presentation Mode</b><br><br>Full-screen slideshow with arrow key navigation.</td>
</tr>
<tr>
<td><b>Focus Mode</b><br><br>Zoomed-in view of a single diagram with pan/zoom controls.</td>
<td><b>File Groups</b><br><br>Collapsible sections organized by source file.</td>
</tr>
</table>

## 🚀 Quick Start

### Prerequisites

- [Zed](https://zed.dev/) v0.210.0 or later
- macOS, Linux, or Windows (standalone mode supported on all platforms)

### Installation

#### As a Zed Dev Extension (Recommended for Development)

```bash
# Build the extension and server
cargo build --release

# Download mermaid.js (~2.5MB)
sh scripts/vendor.sh

# Install as dev extension
sh scripts/install.sh    # macOS/Linux
.\scripts\install.ps1    # Windows
```

Then in Zed:
1. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on macOS)
2. Select "Extensions: Install Development Extension"
3. Choose the project directory

#### As a Standalone App (Without Zed)

```bash
cd server && cargo build --release
cargo run -p mermaid-view-server <path-to-dir> [options]
```

Options:
- `--port 8080` — Specify port
- `--theme light|dark` — Set theme
- `--no-browser` — Don't auto-open browser

### Usage

1. Open a markdown file containing Mermaid code blocks in Zed
2. Edit the diagrams
3. The browser window opens automatically with all diagrams
4. Interact freely: pan, zoom, export, present!

## ⌨️ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `/` | Focus search filter |
| `F` | Fit all diagrams to viewport |
| `R` | Reset zoom and position |
| `P` | Toggle presentation mode |
| `↑` / `↓` | Previous/next diagram (presentation mode) |
| `Esc` | Exit focus/presentation mode |

## ⚙️ Settings

Configure in Zed's `settings.json`:

```json
{
  "mermaidView": {
    "theme": "dark",
    "openOnSave": true
  }
}
```

Valid themes: `"light"`, `"dark"` (default: `"dark"`)

## 🏗️ Architecture

```
┌─────────────┐     LSP Protocol      ┌──────────────┐
│   Zed Editor │ ◀───────────────────▶ │ Rust Server  │
│             │                       │               │
│  mermaid    │                       │ HTTP/WS       │
│  blocks     │◀─────────────────────▶│               │
└─────────────┘     TextDocument      └──────┬───────┘
                                              │
                                              ▼
                                         ┌──────────────┐
                                         │  Browser     │
                                         │   Canvas     │
                                         │              │
                                         │ mermaid.js   │
                                         └──────────────┘
```

### Component Breakdown

- **Extension** (`src/lib.rs`): Zed WASM module that spawns the server process
- **LSP Handler** (`server/src/lsp.rs`): TextDocument synchronization via Language Server Protocol
- **HTTP Server** (`server/src/server.rs`): Static file serving + WebSocket endpoint
- **WebSocket Hub** (`server/src/registry.rs`): Broadcasts changes to all connected clients
- **Web App** (`web/`): Browser-based canvas with pan/zoom, rendering, and navigation
- **Extractor** (`server/src/extract.rs`): Parses Markdown for mermaid blocks

### Data Flow

1. Zed opens markdown file → LSP `didOpen` / `didChange` notifications
2. Server extracts mermaid blocks → updates registry
3. Web client receives changes via WebSocket
4. Removed diagrams fade out → edited diagrams re-render
5. New diagrams appear at their marked positions

## 📁 Project Structure

```
MermaidView/
├── src/                  # Zed extension (WASM bindings)
│   └── lib.rs           # Extension entry point
├── server/               # Rust LSP + HTTP server
│   ├── Cargo.toml       # Dependencies
│   └── src/
│       ├── main.rs      # Entry point
│       ├── lsp.rs       # LSP protocol handler
│       ├── server.rs    # HTTP/WebSocket server
│       ├── extract.rs   # Mermaid block parser (with tests)
│       └── registry.rs  # Diagram state management
├── web/                  # Canvas web application
│   ├── index.html       # Entry page
│   ├── app.js           # Main application logic
│   ├── styles.css       # Theme-aware CSS
│   └── mermaid.min.js   # Vendored mermaid.js
├── scripts/              # Build and install helpers
│   ├── build.sh         # Build extension + server
│   ├── install.sh       # Install as dev extension (macOS/Linux)
│   ├── install.ps1      # Install as dev extension (Windows)
│   └── vendor.sh        # Download mermaid.js
├── extension.toml       # Extension manifest
├── extension.wasm       # Compiled WASM binary (built separately)
├── Cargo.lock           # Lock file
├── Cargo.toml           # Workspace root
└── README.md            # This file
```

## 🧪 Development

### Build

```bash
# Debug build (fast, for development)
cargo build

# Release build (production)
cargo build --release

# Run tests
cargo test -p mermaid-view-server

# Test standalone server
cd server && cargo run -p mermaid-view-server .
```

### Debugging in Zed

1. Install as dev extension
2. Open `settings.json` → add:

```json
{
  "lsp": {
    "mermaid-view": {
      "binary": {
        "path": "/full/path/to/target/debug/mermaid-view-server"
      }
    }
  }
}
```

3. Restart Zed

### Architecture Docs

See `plan/` for research notes and design decisions.

## 📈 Roadmap

- [x] Core rendering pipeline
- [x] Live WebSocket sync
- [x] File grouping + collapse
- [x] Presentation mode
- [ ] Custom diagram layouts (grid, honeycomb)
- [ ] Mermaid plugin support (custom themes/plugins)
- [ ] Keyboard navigation shortcuts (arrow keys)
- [ ] Export entire canvas as image

## 🔒 Security

- **No external dependencies**: Only mermaid.js vendored locally
- **Same-origin policy**: Server runs local-only on `127.0.0.1`
- **No user data uploaded**: All processing stays local to your machine

## 📜 License

MIT License — see [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

- [Mermaid.js](https://mermaid.js.org/) for the diagram rendering engine
- [Zed](https://zed.dev/) for the extension platform
- [LSP RFC](https://github.com/microsoft/language-server-protocol) for protocol specification

---

**Repository**: [southerncoder/MermaidView](https://github.com/southerncoder/MermaidView)

---

**Questions or issues?** Open an issue on GitHub.
