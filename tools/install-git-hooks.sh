#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/.git/hooks/prepare-commit-msg"
install -m 755 "$ROOT/tools/git-hooks/prepare-commit-msg" "$HOOK"
echo "Installed $HOOK"
