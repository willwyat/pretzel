#!/bin/bash
set -euo pipefail
source ~/.env

# Usage: speak.sh "utterance text" ["optional instructions for OpenAI TTS"]
# When instructions are non-empty, uses gpt-4o-mini-tts (instructions are ignored on tts-1 / tts-1-hd).
# With SPEAK_OUT=/path/file.mp3 set, the speech is saved there instead of played (routines
# play the same file on the Pi speaker and send it to Sonos).
# Build JSON safely so quotes, apostrophes, newlines, etc. cannot break curl.
TEXT="${1:?usage: speak.sh TEXT [INSTRUCTIONS]}"
INSTRUCTIONS="${2:-}"

payload="$(
  python3 - "$TEXT" "$INSTRUCTIONS" <<'PY'
import json, sys

text = sys.argv[1]
instructions = (sys.argv[2] if len(sys.argv) > 2 else "").strip()
body = {"model": "tts-1", "input": text, "voice": "nova"}
if instructions:
    body["model"] = "gpt-4o-mini-tts"
    body["instructions"] = instructions
print(json.dumps(body))
PY
)"

if [[ -n "${SPEAK_OUT:-}" ]]; then
  curl -sf -X POST https://api.openai.com/v1/audio/speech \
    -H "Authorization: Bearer $OPENAI_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    -o "$SPEAK_OUT"
  exit 0
fi

curl -s -X POST https://api.openai.com/v1/audio/speech \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$payload" \
  | mpg123 -a hw:2,0 -
