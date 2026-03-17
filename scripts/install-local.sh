#!/usr/bin/env bash
set -euo pipefail

# Antfarm installer (local development version)
# Usage: Run from the antfarm project root directory

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${HOME}/.openclaw/workspace/antfarm"

echo "Installing Antfarm from local project..."

# Create destination directory if it doesn't exist
mkdir -p "$(dirname "$DEST")"

# Remove existing installation
if [ -d "$DEST" ]; then
  echo "Removing existing install..."
  rm -rf "$DEST"
fi

# Copy local project to destination
echo "Copying local project to $DEST..."
cp -r "$SCRIPT_DIR/.." "$DEST"

cd "$DEST"

# Build
echo "Installing dependencies..."
npm install --no-fund --no-audit

echo "Building..."
npm run build

# Link CLI globally
echo "Linking CLI..."
npm link

# Install workflows — use linked CLI or fall back to direct node
ANTFARM="$(command -v antfarm 2>/dev/null || echo "")"
if [ -z "$ANTFARM" ]; then
  ANTFARM="node $DEST/dist/cli/cli.js"
fi

echo "Installing workflows..."
$ANTFARM install

echo ""
echo "Antfarm installed! Run 'antfarm workflow list' to see available workflows."
