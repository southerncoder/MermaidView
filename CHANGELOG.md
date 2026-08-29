# Changelog

All notable changes to MermaidView will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial release of MermaidView extension for Zed

### Changed
- Phase 3: Navigation & Polish — Core features complete, adding final touches

## [0.1.0] - YYYY-MM-DD

### Added
- **Unified Canvas**: Multi-diagram workspace showing all project mermaid diagrams
- **Live Updates**: Real-time WebSocket sync between Zed and browser canvas
- **Pan & Zoom**: Mouse wheel zooming, drag-to-pan navigation
- **Keyboard Shortcuts**: `/`, `F`, `R`, `P` for quick controls
- **File Grouping**: Organize diagrams by file with expand/collapse
- **Presentation Mode**: Full-screen slideshow with arrow key navigation
- **Focus Mode**: Double-click cards for diagram-level pan/zoom
- **Bi-directional Navigation**: Click-to-source and source-highlight links
- **SVG/PNG Export**: Hover card footer for export options
- **Theme Sync**: Automatically matches Zed light/dark theme
- **Debounce Rendering**: Optimized performance with cached renders
- **Standalone Mode**: Run without Zed for testing

### Changed
- Architecture: Hybrid approach using LSP + external preview server

### Security
- No user data uploaded; all processing local to machine
- Same-origin policy enforced for browser client

---

## Future Versions

### [0.2.0] (Planned)
- Custom diagram layouts (grid, honeycomb)
- Keyboard navigation (arrow keys for slide navigation)
- Mermaid plugin support (custom themes)
- Export entire canvas as image/PDF

---

*For more details, see the [roadmap](README.md#roadmap).*
