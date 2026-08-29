#!/bin/bash
set -e

echo "Building MermaidView extension and server..."

# Build the extension (cdylib)
echo "Building extension..."
cargo build --release

# Build the server
echo "Building server..."
cd server
cargo build --release
cd ..

echo ""
echo "Build complete!"
echo "  Extension: target/release/libmermaid_view.dylib (macOS) / mermaid_view.dll (Windows) / libmermaid_view.so (Linux)"
echo "  Server:    server/target/release/mermaid-view-server"