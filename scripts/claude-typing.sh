#!/bin/bash
# stream.md — Claude Code UserPromptSubmit hook
# Posts the user's prompt and sets a status label.

set -e

input=$(cat)

url="${STREAM_MD_URL:-http://localhost:7878}"
channel="${STREAM_MD_CHANNEL:-claude-code}"
label="${STREAM_MD_STATUS:-thinking…}"

# Set status (cleared automatically when /append fires).
printf '%s' "$label" \
  | curl -s --max-time 1 --data-binary @- "$url/$channel/status" > /dev/null 2>&1 || true

# Post a short version of the prompt as a fragment (first 2 lines, capped at 200 chars).
prompt=$(echo "$input" | jq -r '.prompt // empty' 2>/dev/null)
if [ -n "$prompt" ]; then
  short=$(printf '%s' "$prompt" | awk 'NR<=2' | tr '\n' ' ' | sed 's/ *$//')
  if [ ${#short} -gt 200 ]; then
    short="${short:0:197}…"
  elif [ "$(printf '%s' "$prompt" | wc -l | tr -d ' ')" -gt 1 ] || [ ${#prompt} -gt ${#short} ]; then
    short="${short}…"
  fi
  md=$(printf '**You** — %s' "$short")
  printf '%s' "$md" \
    | curl -s --max-time 1 --data-binary @- "$url/$channel/append" > /dev/null 2>&1 || true
fi
