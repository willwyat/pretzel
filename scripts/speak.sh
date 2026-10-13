#!/bin/bash
set -euo pipefail
# Optional overrides (PIPER_*, PRETZEL_MPG123_DEVICE) can live in ~/.env.
if [[ -f ~/.env ]]; then
  # shellcheck disable=SC1090
  source ~/.env
fi

# Usage: speak.sh "utterance text"
# Speaks with Piper on the Pi (no network): the en_GB-semaine-medium voice, speaker
# "prudence", converted to MP3 and played with mpg123. With SPEAK_OUT=/path/file.mp3
# set, the MP3 is saved there instead of played (routines play the same file on the
# Pi speaker and send it to Sonos).
#
# Settings (env or ~/.env):
#   PIPER_BIN      piper executable     (default ~/piper/venv/bin/piper, else `piper` on PATH)
#   PIPER_MODEL    voice model .onnx    (default ~/piper/voices/en_GB-semaine-medium.onnx)
#   PIPER_SPEAKER  speaker name or id   (default prudence; semaine also has spike, obadiah, poppy)
#   PRETZEL_MPG123_DEVICE  ALSA output  (default hw:2,0)
TEXT="${1:?usage: speak.sh TEXT}"

PIPER_BIN="${PIPER_BIN:-$HOME/piper/venv/bin/piper}"
if [[ ! -x "$PIPER_BIN" ]]; then
  PIPER_BIN="$(command -v piper || true)"
fi
[[ -n "$PIPER_BIN" ]] || { echo "speak.sh: piper not found (set PIPER_BIN)" >&2; exit 1; }
PIPER_MODEL="${PIPER_MODEL:-$HOME/piper/voices/en_GB-semaine-medium.onnx}"
[[ -f "$PIPER_MODEL" ]] || { echo "speak.sh: voice model not found: $PIPER_MODEL" >&2; exit 1; }
PIPER_SPEAKER="${PIPER_SPEAKER:-prudence}"
DEVICE="${PRETZEL_MPG123_DEVICE:-hw:2,0}"

# Piper takes a speaker id; look a name up in the model's speaker_id_map.
SPEAKER_ID="$(
  python3 - "$PIPER_MODEL.json" "$PIPER_SPEAKER" <<'PY'
import json, sys

config_path, speaker = sys.argv[1], sys.argv[2]
if speaker.isdigit():
    print(speaker)
    sys.exit(0)
try:
    with open(config_path, encoding="utf-8") as f:
        ids = json.load(f).get("speaker_id_map") or {}
except OSError:
    ids = {}
if speaker not in ids:
    sys.exit(f"speak.sh: speaker {speaker!r} not in {config_path} (have: {', '.join(ids) or 'none'})")
print(ids[speaker])
PY
)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

printf '%s' "$TEXT" | "$PIPER_BIN" -m "$PIPER_MODEL" -s "$SPEAKER_ID" -f "$WORK/speech.wav" 2>"$WORK/piper.log" || {
  cat "$WORK/piper.log" >&2
  exit 1
}

# MP3 so the Pi (mpg123) and Sonos (audio clips) play the same file.
if command -v lame >/dev/null 2>&1; then
  lame --quiet -b 96 "$WORK/speech.wav" "$WORK/speech.mp3"
else
  ffmpeg -loglevel error -y -i "$WORK/speech.wav" -codec:a libmp3lame -b:a 96k "$WORK/speech.mp3"
fi

if [[ -n "${SPEAK_OUT:-}" ]]; then
  mv "$WORK/speech.mp3" "$SPEAK_OUT"
  exit 0
fi

mpg123 -q -a "$DEVICE" "$WORK/speech.mp3"
