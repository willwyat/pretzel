#!/usr/bin/env sh
# Usage: ./scripts/curl-speak.sh "Hello! I'm Pretzel."
# Uses POST + text/plain so apostrophes in the message are safe for the shell.
set -e
BASE="${PRETZEL_URL:-http://pretzel.local:3001}"
if [ -z "${1:-}" ]; then
  echo "usage: $0 \"message to speak\"" >&2
  exit 1
fi
exec curl -sS -X POST "$BASE/pretzel/speak" \
  -H "Content-Type: text/plain; charset=utf-8" \
  --data-binary "$1"
