#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$ROOT_DIR"

echo "=== Building all LibreChat Search images ==="

echo ""
echo "--- gemini-search-proxy ---"
bash "$SCRIPT_DIR/gemini-search-proxy.sh"

echo ""
echo "--- openai-search-proxy ---"
bash "$SCRIPT_DIR/openai-search-proxy.sh"

echo ""
echo "--- analytics-service ---"
bash "$SCRIPT_DIR/analytics-service.sh"

echo ""
echo "--- analytics-dashboard ---"
bash "$SCRIPT_DIR/analytics-dashboard.sh"

echo ""
echo "--- token-refresher ---"
bash "$SCRIPT_DIR/token-refresher.sh"

echo ""
echo "=== All images built and pushed ==="
