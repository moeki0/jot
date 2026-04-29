import { join } from "node:path";

type Fragment = {
  id: number;
  channel: string;
  ts: number;
  markdown: string;
};

type Event =
  | { type: "fragment"; fragment: Fragment }
  | { type: "status"; channel: string; status: string | null };

const channels = new Map<string, Fragment[]>();
const statusState = new Map<string, string | null>();
const subscribers = new Map<string, Set<(e: Event) => void>>();
let nextId = 1;

function emit(channel: string, e: Event) {
  for (const cb of subscribers.get(channel) ?? []) cb(e);
}

const MAX_FRAGMENTS_PER_CHANNEL = 500;

function append(channel: string, markdown: string): Fragment {
  const f: Fragment = { id: nextId++, channel, ts: Date.now(), markdown };
  const arr = channels.get(channel) ?? [];
  arr.push(f);
  if (arr.length > MAX_FRAGMENTS_PER_CHANNEL) {
    arr.splice(0, arr.length - MAX_FRAGMENTS_PER_CHANNEL);
  }
  channels.set(channel, arr);
  emit(channel, { type: "fragment", fragment: f });
  return f;
}

function setStatus(channel: string, status: string | null) {
  if ((statusState.get(channel) ?? null) === status) return;
  statusState.set(channel, status);
  emit(channel, { type: "status", channel, status });
}

function subscribe(channel: string, cb: (e: Event) => void): () => void {
  const set = subscribers.get(channel) ?? new Set();
  set.add(cb);
  subscribers.set(channel, set);
  return () => set.delete(cb);
}

const PUBLIC = join(import.meta.dir, "..", "public");

export function serve(port: number) {
  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;

      if (p === "/" || p === "/index.html") {
        return new Response(Bun.file(join(PUBLIC, "index.html")));
      }
      if (p === "/app.js" || p === "/marked.js" || p === "/hljs.js") {
        return new Response(Bun.file(join(PUBLIC, p.slice(1))), {
          headers: {
            "content-type": "text/javascript",
            "cache-control": "no-cache",
          },
        });
      }
      if (p === "/style.css") {
        return new Response(Bun.file(join(PUBLIC, "style.css")), {
          headers: {
            "content-type": "text/css",
            "cache-control": "no-cache",
          },
        });
      }

      // GET /channels — list of channels with counts
      if (p === "/channels" && req.method === "GET") {
        const list = [...channels.entries()].map(([name, frags]) => ({
          name,
          count: frags.length,
          last: frags[frags.length - 1]?.ts ?? null,
        }));
        return Response.json(list);
      }

      // POST /:channel/append
      const appendMatch = p.match(/^\/([^/]+)\/append$/);
      if (appendMatch && req.method === "POST") {
        const channel = decodeURIComponent(appendMatch[1]!);
        const md = await req.text();
        if (!md.trim()) return new Response("empty", { status: 400 });
        const f = append(channel, md);
        return Response.json({ ok: true, id: f.id });
      }

      // POST /:channel/status — set status label (or empty/"off" to clear)
      const statusMatch = p.match(/^\/([^/]+)\/status$/);
      if (statusMatch && req.method === "POST") {
        const channel = decodeURIComponent(statusMatch[1]!);
        const body = (await req.text()).trim();
        const cleared = body === "" || body === "off" || body === "0" || body === "false";
        setStatus(channel, cleared ? null : body);
        return Response.json({ ok: true, status: cleared ? null : body });
      }

      // GET /:channel — fragments JSON, or HTML if browser
      const channelMatch = p.match(/^\/([^/]+)$/);
      if (channelMatch && req.method === "GET") {
        const wantsHtml = (req.headers.get("accept") ?? "").includes("text/html");
        if (wantsHtml) {
          return new Response(Bun.file(join(PUBLIC, "index.html")));
        }
        const channel = decodeURIComponent(channelMatch[1]!);
        const frags = channels.get(channel) ?? [];
        return Response.json(frags);
      }

      // GET /:channel/stream — SSE
      const streamMatch = p.match(/^\/([^/]+)\/stream$/);
      if (streamMatch && req.method === "GET") {
        const channel = decodeURIComponent(streamMatch[1]!);
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            // backlog as fragment events
            for (const f of channels.get(channel) ?? []) {
              const ev: Event = { type: "fragment", fragment: f };
              controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
            }
            // current status if any
            const cur = statusState.get(channel);
            if (cur) {
              const ev: Event = { type: "status", channel, status: cur };
              controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
            }
            const unsub = subscribe(channel, (e) => {
              controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
            });
            req.signal.addEventListener("abort", () => {
              unsub();
              controller.close();
            });
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });
}
