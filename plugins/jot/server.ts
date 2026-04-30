#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const BASE = (process.env.JOT_URL ?? "http://localhost:7878").replace(/\/$/, "");
const CHANNEL = process.env.JOT_CHANNEL ?? "claude-code";

const mcp = new Server(
  { name: "jot", version: "0.5.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
    },
    instructions:
      `Messages from the jot ${CHANNEL} channel arrive as <channel source="jot" channel="..." id="..." ts="...">. ` +
      `Anything posted via the browser composer or any HTTP client to /:channel/append shows up here. ` +
      `Your replies are posted back automatically by the jot Stop hook — there is no reply tool.\n\n` +
      `When you want to ask the user a multiple-choice question, write a plain bullet list where every item ` +
      `is one of: \`- Option <id>: <text>\`, \`- 選択肢 <id>: <text>\`, \`- Yes\` / \`- Yes: <text>\`, \`- No\` / \`- No: <text>\`, ` +
      `\`- はい\` / \`- はい: <text>\`, \`- いいえ\` / \`- いいえ: <text>\`. ` +
      `Put an optional question paragraph immediately above the list. The list will render as clickable buttons ` +
      `in the jot UI, and the user's selection will arrive as your next user prompt. ` +
      `End your turn after writing the list — do not call any tool.`,
  },
);

let lastSeen = 0;
async function pollLoop() {
  while (true) {
    try {
      const url = `${BASE}/${encodeURIComponent(CHANNEL)}/wait?since=${lastSeen}&timeout=300000`;
      const res = await fetch(url);
      if (res.status === 408) continue;
      if (!res.ok) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      const { fragment } = (await res.json()) as { fragment: { id: number; ts: number; markdown: string } };
      lastSeen = fragment.id;
      const tsIso = new Date(fragment.ts).toISOString();
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: fragment.markdown,
          meta: { channel: CHANNEL, id: String(fragment.id), ts: tsIso },
        },
      });
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function init() {
  try {
    const r = await fetch(`${BASE}/${encodeURIComponent(CHANNEL)}`);
    if (r.ok) {
      const arr = (await r.json()) as { id: number }[];
      lastSeen = arr.reduce((m, f) => Math.max(m, f.id), 0);
    }
  } catch {}
}

await init();
await mcp.connect(new StdioServerTransport());
pollLoop();
