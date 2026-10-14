#!/usr/bin/env bash
# Clean up unnecessary files before packaging to reduce release size
set -Eeuo pipefail

echo "Optimizing release package size..."

# 1. Remove all Python bytecode caches from modules
echo "Removing Python bytecode caches..."
find modules -type d -name "__pycache__" -print -exec rm -rf {} + 2>/dev/null || true
find modules -type f -name "*.pyc" -print -delete 2>/dev/null || true
find modules -type f -name "*.pyo" -print -delete 2>/dev/null || true

# 2. Show size summary
echo ""
echo "Optimization complete. Test directories are excluded by package-release.py EXCLUDED set."
PYCACHE_COUNT=$(find modules -type d -name "__pycache__" 2>/dev/null | wc -l)
if [ "$PYCACHE_COUNT" -eq 0 ]; then
    echo "  ✓ No __pycache__ directories remaining"
else
    echo "  ⚠ Warning: $PYCACHE_COUNT __pycache__ directories still present"
fi
echo ""
