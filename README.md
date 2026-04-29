# jot

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
- `POST /:channel/permission` — body is Markdown; long-polls until the browser POSTs `/decide/:id`. Response: `{id, decision:"allow"|"deny", message?}` or 408 timeout. Optional `?timeout=ms` (default 600000).
- `POST /:channel/decide/:id` — body `{decision:"allow"|"deny", message?}`. Browser sends this when the user clicks Allow/Deny.
- `GET /:channel` — JSON of fragments (HTML if browser)
- `GET /:channel/stream` — SSE stream of `{type:"fragment"|"status"|"decided", ...}` events (backlog + live)
- `GET /:channel/wait?since=<id>&timeout=<ms>` — long-poll for the next non-internal fragment (used by the MCP bridge).
- `GET /channels` — list with counts

## Rendering

- Markdown via `marked`
- ` ```diff ` and ` ```diff:<lang> ` blocks: red/green per-line, supports `@@` hunk headers; with `:<lang>` the inner code is syntax-highlighted
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
    "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/jot/scripts/claude-typing.sh" }] }],
    "Stop":             [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/jot/scripts/claude-hook.sh"   }] }],
    "PreToolUse":       [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/jot/scripts/claude-tool.sh"   }] }],
    "Notification":     [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/jot/scripts/claude-notify.sh" }] }]
  }
}
```

Override the channel or label via env: `JOT_URL`, `JOT_CHANNEL`, `JOT_STATUS`.

Both Claude Code and Codex hooks use the shared channel resolver in
`scripts/_jot-channel.sh`. By default, the first prompt of a session becomes a
short channel slug; later hooks with the same `session_id` reuse that channel.
Set `JOT_CHANNEL` to force one fixed channel across all agents.

## Claude Code Channels MCP

A small MCP server bridges a jot channel into a Claude Code session as a Claude Code Channel: GUI posts arrive as `<channel source="stream-md" ...>` ambient messages, and Claude can post back via the `reply` tool. See `~/.claude/mcp/jot/index.ts` for the implementation.

