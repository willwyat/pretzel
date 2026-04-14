#!/bin/bash
source ~/.env
curl -s -X POST https://api.openai.com/v1/audio/speech \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"tts-1\",\"input\":\"$1\",\"voice\":\"nova\"}" \
  | mpg123 -a hw:2,0 -

