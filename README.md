# stream.md

Post Markdown fragments over HTTP. Read them flowing in your browser.

```bash
bun install
bun start
# http://localhost:7878/<channel>
```

Push a fragment:

```bash
echo "## hello" | curl -s --data-binary @- localhost:7878/claude-code/append
```

Channels are created on first POST. In-memory only — fragments vanish when the server stops. Each channel keeps the most recent 500 fragments.

## API

- `POST /:channel/append` — body is Markdown
- `POST /:channel/status` — body is a label string ("thinking…", "building…", …); empty/`off`/`0` clears
- `GET /:channel` — JSON of fragments (HTML if browser)
- `GET /:channel/stream` — SSE stream of `{type:"fragment"|"status", ...}` events (backlog + live)
- `GET /channels` — list with counts

## Rendering

- Markdown via `marked`
- ` ```diff ` blocks: red/green per-line, supports `@@` hunk headers (use `diff -u`)
- ` ```bash ` (and other languages registered in `public/hljs.js`): syntax-highlighted

## Claude Code hooks

The `scripts/` directory has hooks that wire Claude Code to a `claude-code` channel:

| Hook | Script | What it does |
|---|---|---|
| `UserPromptSubmit` | `claude-typing.sh` | Posts the user prompt (truncated) and sets status to `thinking…` |
| `Stop` | `claude-hook.sh` | Posts the assistant's text reply, clears the status |
| `PreToolUse` | `claude-tool.sh` | Posts a Markdown fragment per tool call (Edit shows a real `diff -u`) |
| `Notification` | `claude-notify.sh` | Posts permission asks / idle alerts |

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/stream.md/scripts/claude-typing.sh" }] }],
    "Stop":             [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/stream.md/scripts/claude-hook.sh"   }] }],
    "PreToolUse":       [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/stream.md/scripts/claude-tool.sh"   }] }],
    "Notification":     [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/stream.md/scripts/claude-notify.sh" }] }]
  }
}
```

Override the channel or label via env: `STREAM_MD_URL`, `STREAM_MD_CHANNEL`, `STREAM_MD_STATUS`.

## UI

- No auto-scroll. New fragments appear at the bottom; the page stays where you were reading.
- Bottom pill shows status (e.g. `thinking…`) and unread count (`↓ N new`); click to jump to the oldest unread.
- Fragments fade in. Once a fragment scrolls past the viewport's bottom edge, it counts as read.
- Channel switcher: header button or `Cmd/Ctrl+K`.
