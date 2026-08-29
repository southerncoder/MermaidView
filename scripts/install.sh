#!/bin/bash
set -e

echo "Installing MermaidView as a Zed development extension..."

ZED_DIR="$HOME/Library/Application Support/zed/dev_extensions"
if [ -d "$HOME/.config/zed" ]; then
  ZED_DIR="$HOME/.config/zed/dev_extensions"
fi

mkdir -p "$ZED_DIR"

# Copy extension files
EXT_DIR="$ZED_DIR/mermaid-view"
mkdir -p "$EXT_DIR"

cp extension.toml "$EXT_DIR/"
cp Cargo.toml "$EXT_DIR/"
cp -r src "$EXT_DIR/"
cp -r server "$EXT_DIR/"
cp -r web "$EXT_DIR/"
cp -r languages "$EXT_DIR/"

echo "Installed to: $EXT_DIR"
echo ""
echo "To load in Zed:"
echo "  1. Open Zed"
echo "  2. Run: Extensions: Install Development Extension"
echo "  3. Select: $EXT_DIR"
echo ""
echo "Or open Zed from this directory:"
echo "  cd $EXT_DIR && zed"