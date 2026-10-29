#!/usr/bin/env bash
# Adds claude-switch to PATH and sets up the `cs` alias in ~/.bashrc.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$REPO_DIR/bin"
RC="$HOME/.bashrc"
MARKER="# claude-switch"

command -v node >/dev/null || { echo "Node.js is required: https://nodejs.org" >&2; exit 1; }
chmod +x "$BIN_DIR/claude-switch"

touch "$RC"
# Drop any previous install (or older hand-added `cs` alias) before writing a fresh one.
sed -i "/$MARKER/d; /^alias cs=/d" "$RC"
cat >> "$RC" <<EOF
export PATH="\$PATH:$BIN_DIR" $MARKER
alias cs='claude-switch' $MARKER
EOF

echo "Installed. Open a new terminal (or run: source ~/.bashrc), then:"
echo "  1. Log in to each account in Claude Code with /login and run: claude-switch save"
echo "  2. Type cs to switch accounts."
