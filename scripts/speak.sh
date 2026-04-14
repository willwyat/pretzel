#!/bin/bash
set -euo pipefail
source ~/.env

# Build JSON safely so quotes, apostrophes, newlines, etc. in the utterance cannot break curl.
payload="$(
  python3 -c 'import json,sys; print(json.dumps({"model":"tts-1","input":sys.argv[1],"voice":"nova"}))' "$1"
)"

curl -s -X POST https://api.openai.com/v1/audio/speech \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$payload" \
  | mpg123 -a hw:2,0 -
