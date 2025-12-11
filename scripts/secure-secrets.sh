#!/usr/bin/env bash
# Secure secret files with restrictive permissions
# Run this after creating new .secret.yaml files

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "🔒 Securing secret files..."

# Set 600 (owner read/write only) on all .secret.yaml files
find "$PROJECT_ROOT" -name "*.secret.yaml" -type f -exec chmod 600 {} \;

# Set 700 (owner only) on secrets directories
find "$PROJECT_ROOT/k8s" -type d -name "secrets" -exec chmod 700 {} \; 2>/dev/null || true

# Count secured files
SECRET_COUNT=$(find "$PROJECT_ROOT" -name "*.secret.yaml" -type f | wc -l | tr -d ' ')
DIR_COUNT=$(find "$PROJECT_ROOT/k8s" -type d -name "secrets" 2>/dev/null | wc -l | tr -d ' ')

echo "✅ Secured $SECRET_COUNT secret files (chmod 600)"
echo "✅ Secured $DIR_COUNT secrets directories (chmod 700)"
