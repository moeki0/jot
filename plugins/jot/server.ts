#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const BASE = (process.env.JOT_URL ?? "http://localhost:7878").replace(/\/$/, "");
const CHANNEL = process.env.JOT_CHANNEL ?? "claude-code";

const selfIds = new Set<number>();

const mcp = new Server(
  { name: "jot", version: "0.4.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions:
      `Messages from the jot ${CHANNEL} channel arrive as <channel source="jot" channel="..." id="..." ts="...">. ` +
      `Anything posted via the browser composer or any HTTP client to /:channel/append shows up here. ` +
      `Reply with the reply tool — markdown is appended to the same channel and rendered in the browser.`,
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Post a markdown fragment back to the jot channel. Self-posted ids are not redelivered as channel events.",
      inputSchema: {
        type: "object" as const,
        properties: { markdown: { type: "string" } },
        required: ["markdown"],
      },
    },
    {
      name: "list_channels",
      description: "List jot channels with fragment counts.",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === "reply") {
    const markdown = String((args as any)?.markdown ?? "");
    if (!markdown.trim()) throw new Error("markdown is empty");
    const res = await fetch(`${BASE}/${encodeURIComponent(CHANNEL)}/append`, {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: markdown,
    });
    if (!res.ok) throw new Error(`jot /append ${res.status}: ${await res.text()}`);
    const { id } = (await res.json()) as { id: number };
    selfIds.add(id);
    return { content: [{ type: "text" as const, text: JSON.stringify({ id }) }] };
  }
  if (name === "list_channels") {
    const res = await fetch(`${BASE}/channels`);
    if (!res.ok) throw new Error(`jot /channels ${res.status}`);
    return { content: [{ type: "text" as const, text: await res.text() }] };
  }
  throw new Error(`unknown tool: ${name}`);
});

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
      if (selfIds.has(fragment.id)) continue;
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
