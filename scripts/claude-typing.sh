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

# Set an ephemeral "thinking" message (cleared by the Stop hook).
printf '%s' "$label" \
  | curl -s --max-time 1 --data-binary @- "$url/$channel/ephemeral?key=thinking" > /dev/null 2>&1 || true

# Post a short version of the prompt as a fragment (first 2 lines, capped at 200 chars).
prompt=$(echo "$input" | jq -r '.prompt // empty' 2>/dev/null)
# Skip jot's own channel events (avoid echoing GUI posts back as "You — ..."),
# but pass through other harness channels like tunr/imessage so they show up.
case "$prompt" in
  *'<channel source="jot"'*) prompt="" ;;
esac
if [ -n "$prompt" ]; then
  # Detect harness channel events (e.g. tunr screen updates). For those,
  # extract the source and render with a channel prefix instead of "You".
  source=$(printf '%s' "$prompt" | sed -n 's/.*<channel source="\([^"]*\)".*/\1/p' | head -n1)
  short=$(printf '%s' "$prompt" | awk 'NR<=2' | tr '\n' ' ' | sed 's/ *$//')
  if [ ${#short} -gt 200 ]; then
    short="${short:0:197}…"
  elif [ "$(printf '%s' "$prompt" | wc -l | tr -d ' ')" -gt 1 ] || [ ${#prompt} -gt ${#short} ]; then
    short="${short}…"
  fi
  if [ -n "$source" ]; then
    md=$(printf '**%s** — %s' "$source" "$short")
  else
    md=$(printf '**You** — %s' "$short")
  fi
  printf '%s' "$md" \
    | curl -s --max-time 1 --data-binary @- "$url/$channel/append?internal=1" > /dev/null 2>&1 || true
fi
