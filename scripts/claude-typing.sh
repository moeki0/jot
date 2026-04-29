#!/bin/bash
# stream.md — Claude Code UserPromptSubmit hook
# Posts the user's prompt and sets a status label.

set -e

input=$(cat)

url="${JOT_URL:-http://localhost:7878}"
label="${JOT_STATUS:-Thinking…}"

. "$(dirname "$0")/_jot-channel.sh"
session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
prompt_for_slug=$(echo "$input" | jq -r '.prompt // empty' 2>/dev/null)
resolve_jot_channel "$session_id" "$prompt_for_slug"
channel="$JOT_CHANNEL_RESOLVED"

# Set status (cleared automatically when /append fires).
printf '%s' "$label" \
  | curl -s --max-time 1 --data-binary @- "$url/$channel/status" > /dev/null 2>&1 || true

# Post a short version of the prompt as a fragment (first 2 lines, capped at 200 chars).
prompt=$(echo "$input" | jq -r '.prompt // empty' 2>/dev/null)
# Skip if the prompt is itself a channel event ingested from the harness
# (jot/tunr/imessage/etc) — avoids echoing GUI posts and notifications back
# into the timeline as a "You — ..." line.
case "$prompt" in
  *'<channel source="'*) prompt="" ;;
esac
if [ -n "$prompt" ]; then
  short=$(printf '%s' "$prompt" | awk 'NR<=2' | tr '\n' ' ' | sed 's/ *$//')
  if [ ${#short} -gt 200 ]; then
    short="${short:0:197}…"
  elif [ "$(printf '%s' "$prompt" | wc -l | tr -d ' ')" -gt 1 ] || [ ${#prompt} -gt ${#short} ]; then
    short="${short}…"
  fi
  md=$(printf '**You** — %s' "$short")
  printf '%s' "$md" \
    | curl -s --max-time 1 --data-binary @- "$url/$channel/append?internal=1" > /dev/null 2>&1 || true
fi
