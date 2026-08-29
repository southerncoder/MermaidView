#!/bin/bash
set -e

echo "Vendoring mermaid.js and dependencies..."

MERMAID_VERSION="11.4.1"
MERMAID_URL="https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js"
DEST="web/mermaid.min.js"

if [ -f "$DEST" ]; then
  echo "mermaid.min.js already exists. Re-download? (y/n)"
  read -r answer
  if [ "$answer" != "y" ]; then
    echo "Skipping download."
    exit 0
  fi
fi

echo "Downloading mermaid.js v${MERMAID_VERSION}..."
mkdir -p web
curl -sL "$MERMAID_URL" -o "$DEST"

SIZE=$(wc -c < "$DEST")
echo "Downloaded: $DEST ($SIZE bytes)"

# Verify it's valid JS
if head -c 100 "$DEST" | grep -q "mermaid"; then
  echo "✓ mermaid.js looks valid"
else
  echo "⚠ mermaid.js may not be valid (check the file)"
fi