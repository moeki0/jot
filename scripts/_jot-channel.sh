#!/bin/bash
# jot — channel resolver shared by agent hooks.
#
# Maps each agent session_id to a jot channel, persisting the mapping in
# ~/.config/jot/sessions.json. The first prompt of a session is used to derive
# a short slug; later hook calls in the same session re-use it.
#
# Usage (source this file, then call):
# Optional env:
#   JOT_CHANNEL          force every hook call to this channel
#   JOT_DEFAULT_CHANNEL  channel used when no session_id is present
#   JOT_SESSION_PREFIX   prefix for no-prompt session channels
#   JOT_SESSIONS_FILE    session_id -> channel map file
#
# Usage:
#   resolve_jot_channel <session_id> [prompt]
# Sets $JOT_CHANNEL_RESOLVED.

resolve_jot_channel() {
  local sid="$1"
  local prompt="${2:-}"

  if [ -n "$JOT_CHANNEL" ]; then
    JOT_CHANNEL_RESOLVED="$JOT_CHANNEL"
    return 0
  fi

  if [ -z "$sid" ]; then
    JOT_CHANNEL_RESOLVED="${JOT_DEFAULT_CHANNEL:-claude-code}"
    return 0
  fi

  local map="${JOT_SESSIONS_FILE:-$HOME/.config/jot/sessions.json}"
  mkdir -p "$(dirname "$map")" 2>/dev/null || true
  [ -f "$map" ] || echo "{}" > "$map" 2>/dev/null || true

  local existing
  if [ -f "$map" ]; then
    existing=$(jq -r --arg sid "$sid" '.[$sid] // empty' "$map" 2>/dev/null || true)
  else
    existing=""
  fi

  # If the GUI included a routing marker (`<jot-route channel="X" />`), use
  # that as the session's channel — this lets users on cc-XXXX cause Claude to
  # reply to cc-XXXX even though the harness only ingests one fixed channel.
  local from_prompt=""
  if [ -n "$prompt" ]; then
    from_prompt=$(printf '%s' "$prompt" \
      | grep -oE '<jot-route channel="[^"]+"' \
      | tail -1 \
      | sed -E 's/.*channel="([^"]+)".*/\1/')
  fi

  if [ -n "$from_prompt" ] && [ "$from_prompt" != "$existing" ]; then
    local tmp
    tmp=$(mktemp)
    if [ -f "$map" ] && jq --arg sid "$sid" --arg ch "$from_prompt" '. + {($sid): $ch}' "$map" > "$tmp" 2>/dev/null; then
      mv "$tmp" "$map" 2>/dev/null || true
    else
      rm -f "$tmp"
    fi
    JOT_CHANNEL_RESOLVED="$from_prompt"
    return 0
  fi

  if [ -n "$existing" ]; then
    JOT_CHANNEL_RESOLVED="$existing"
    return 0
  fi

  local slug=""
  if [ -n "$prompt" ]; then
    # 3 words from the first 200 chars, ASCII-only, dash-joined.
    local words
    words=$(printf '%s' "$prompt" \
      | head -c 200 \
      | tr 'A-Z' 'a-z' \
      | LC_ALL=C tr -c 'a-z0-9' ' ' \
      | tr -s ' ' \
      | sed 's/^ //; s/ $//')
    slug=$(printf '%s' "$words" | awk '{ for (i=1;i<=NF&&i<=3;i++) printf "%s%s", $(i), (i==NF||i==3?"":"-") }')
    slug=$(printf '%s' "$slug" | cut -c 1-32 | sed 's/-$//')
  fi

  local sid_short="${sid:0:6}"
  local prefix="${JOT_SESSION_PREFIX:-cc}"
  local channel
  if [ -n "$slug" ]; then
    channel="${slug}-${sid_short}"
  else
    channel="${prefix}-${sid_short}"
  fi

  if [ -n "$prompt" ]; then
    local tmp
    tmp=$(mktemp)
    if [ -f "$map" ] && jq --arg sid "$sid" --arg ch "$channel" '. + {($sid): $ch}' "$map" > "$tmp" 2>/dev/null; then
      mv "$tmp" "$map" 2>/dev/null || true
    else
      rm -f "$tmp"
    fi
  fi

  JOT_CHANNEL_RESOLVED="$channel"
}
