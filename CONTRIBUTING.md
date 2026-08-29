# Contributing to MermaidView

Welcome! We appreciate your interest in contributing to **MermaidView** — a Zed extension for multi-diagram visualization.

## How You Can Help

### 🐛 Report Bugs

Found a bug? [Open an issue](https://github.com/southerncoder/MermaidView/issues) with:
- Steps to reproduce
- Expected vs actual behavior
- Screenshots if applicable
- Your Zed version and OS

### 💡 Suggest Features

Have an idea? We're always looking for enhancements. Describe your use case!

### 🔧 Fix Issues

Good first issues are marked in the repo. Look for:
- "bug" label — fixes needed
- "help wanted" — tasks needing assistance
- "enhancement" — feature improvements

## Development Setup

### Prerequisites

- [Rust](https://rustup.rs/) 1.75+
- [Zed](https://zed.dev/) v0.210.0+ (for testing)

### Building

```bash
cd server && cargo build --release
sh scripts/vendor.sh    # Download mermaid.js
```

### Running in Development Mode

```bash
# macOS/Linux
sh scripts/install.sh
# Windows
.\scripts\install.ps1

# Install as dev extension in Zed
# Then: Ctrl+Shift+P → "Extensions: Install Development Extension"
```

### Testing

```bash
cd server && cargo test

# Run standalone server (optional)
cargo run -p mermaid-view-server .
```

## Code Style

- Follow Rust's [official style guide](https://rust-lang.github.io/api-guidelines/)
- Add tests for new functionality
- Keep functions small and focused

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```bash
feat: add presentation mode
fix: resolve websocket connection timeout
docs: update README installation steps
```

## Questions?

- Check existing [issues](https://github.com/southerncoder/MermaidView/issues)
- Read the [architecture docs](../plan/) for context
- Ping us in GitHub discussions

---

**Thank you for contributing!** 🙏
