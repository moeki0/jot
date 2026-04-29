import { join } from "node:path";

type GateAction = {
  label: string;
  value: string;
  color?: string;
  // Freeform extra payload (e.g. remember, scope, reason). Sent back to caller verbatim.
  [key: string]: unknown;
};

type Fragment = {
  id: number;
  channel: string;
  ts: number;
  markdown: string;
  awaiting?: boolean;
  internal?: boolean;
  actions?: GateAction[];
};

type EphemeralValue = { markdown: string; animation: string };

type Event =
  | { type: "fragment"; fragment: Fragment }
  | { type: "ephemeral"; channel: string; key: string; markdown: string | null; animation?: string }
  | { type: "awaiting"; id: number; markdown?: string; actions?: GateAction[] }
  | { type: "decided"; id: number; value: string; message?: string };

type DecisionPayload = { value: string; message?: string; [key: string]: unknown };

type PendingDecision = {
  actions?: GateAction[];
  resolve: (d: DecisionPayload) => void;
};

type Gate = {
  channel: string;
  fragmentId: number;
  onSignal: (extraMd?: string) => void;
};

const channels = new Map<string, Fragment[]>();
const ephemerals = new Map<string, Map<string, EphemeralValue>>();
const subscribers = new Map<string, Set<(e: Event) => void>>();
const pendings = new Map<number, PendingDecision>();
const gates = new Map<string, Gate>();
let nextId = 1;

function emit(channel: string, e: Event) {
  for (const cb of subscribers.get(channel) ?? []) cb(e);
}

const MAX_FRAGMENTS_PER_CHANNEL = 500;

function append(channel: string, markdown: string, awaiting = false, internal = false): Fragment {
  const f: Fragment = { id: nextId++, channel, ts: Date.now(), markdown };
  if (awaiting) f.awaiting = true;
  if (internal) f.internal = true;
  const arr = channels.get(channel) ?? [];
  arr.push(f);
  if (arr.length > MAX_FRAGMENTS_PER_CHANNEL) {
    arr.splice(0, arr.length - MAX_FRAGMENTS_PER_CHANNEL);
  }
  channels.set(channel, arr);
  emit(channel, { type: "fragment", fragment: f });
  return f;
}

function resolveAwaiting(channel: string, id: number, value: string, message?: string) {
  const arr = channels.get(channel);
  if (arr) {
    const f = arr.find((x) => x.id === id);
    if (f) f.awaiting = false;
  }
  emit(channel, { type: "decided", id, value, message });
}

function setEphemeral(channel: string, key: string, markdown: string | null, animation: string = "typing") {
  const map = ephemerals.get(channel) ?? new Map<string, EphemeralValue>();
  if (markdown === null) {
    if (!map.has(key)) return;
    map.delete(key);
  } else {
    const cur = map.get(key);
    if (cur && cur.markdown === markdown && cur.animation === animation) return;
    map.set(key, { markdown, animation });
  }
  ephemerals.set(channel, map);
  emit(channel, { type: "ephemeral", channel, key, markdown, animation });
}

function clearAllEphemerals(channel: string) {
  const map = ephemerals.get(channel);
  if (!map || map.size === 0) return;
  const keys = [...map.keys()];
  map.clear();
  for (const key of keys) emit(channel, { type: "ephemeral", channel, key, markdown: null });
}

function subscribe(channel: string, cb: (e: Event) => void): () => void {
  const set = subscribers.get(channel) ?? new Set();
  set.add(cb);
  subscribers.set(channel, set);
  return () => set.delete(cb);
}

const PUBLIC = join(import.meta.dir, "..", "public");
const UPLOADS = process.env.JOT_UPLOADS_DIR ?? join(process.env.HOME ?? "/tmp", ".jot", "uploads");

const securityHeaders = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' http: https: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export function serve(port: number) {
  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;

      if (p === "/" || p === "/index.html") {
        return new Response(Bun.file(join(PUBLIC, "index.html")), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            ...securityHeaders,
          },
        });
      }
      if (p === "/app.js" || /^\/app-[a-zA-Z0-9_-]+\.js$/.test(p)) {
        return new Response(Bun.file(join(PUBLIC, p.slice(1))), {
          headers: {
            "content-type": "text/javascript",
            "cache-control": "no-cache",
          },
        });
      }
      if (p === "/index.css") {
        return new Response(Bun.file(join(PUBLIC, p.slice(1))), {
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

      // GET /uploads/:channel/:file — serve uploaded files (so <img> works in markdown).
      const uploadFileMatch = p.match(/^\/uploads\/([^/]+)\/([^/]+)$/);
      if (uploadFileMatch && req.method === "GET") {
        const ch = decodeURIComponent(uploadFileMatch[1]!).replace(/[^A-Za-z0-9._-]/g, "_");
        const name = decodeURIComponent(uploadFileMatch[2]!);
        if (name.includes("..") || name.includes("/")) return new Response("bad path", { status: 400 });
        return new Response(Bun.file(join(UPLOADS, ch, name)));
      }

      // POST /:channel/upload — multipart upload; saves files locally and returns
      // both an absolute filesystem path (for Claude / shell tools) and an http
      // URL (so the GUI can render the file inline).
      const uploadMatch = p.match(/^\/([^/]+)\/upload$/);
      if (uploadMatch && req.method === "POST") {
        const channel = decodeURIComponent(uploadMatch[1]!);
        const safeChannel = channel.replace(/[^A-Za-z0-9._-]/g, "_");
        const dir = join(UPLOADS, safeChannel);
        await Bun.write(join(dir, ".keep"), "");
        const form = await req.formData();
        const files: { path: string; url: string; name: string }[] = [];
        for (const entry of form.getAll("files")) {
          if (!(entry instanceof File)) continue;
          const safeName = entry.name.replace(/[\\/\x00-\x1f]/g, "_").replace(/^\.+/, "_") || "file";
          const stamped = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
          const dest = join(dir, stamped);
          await Bun.write(dest, entry);
          files.push({
            path: dest,
            url: `/uploads/${encodeURIComponent(safeChannel)}/${encodeURIComponent(stamped)}`,
            name: entry.name,
          });
        }
        return Response.json({ files, paths: files.map((f) => f.path) });
      }

      // POST /:channel/append
      const appendMatch = p.match(/^\/([^/]+)\/append$/);
      if (appendMatch && req.method === "POST") {
        const channel = decodeURIComponent(appendMatch[1]!);
        const md = await req.text();
        if (!md.trim()) return new Response("empty", { status: 400 });
        const internal = url.searchParams.get("internal") === "1";
        const f = append(channel, md, false, internal);
        return Response.json({ ok: true, id: f.id });
      }

      // GET /:channel/wait?since=<id>&timeout=<ms> — long-poll for the next fragment with id > since
      const waitMatch = p.match(/^\/([^/]+)\/wait$/);
      if (waitMatch && req.method === "GET") {
        const channel = decodeURIComponent(waitMatch[1]!);
        const since = Number(url.searchParams.get("since") ?? 0);
        const timeoutMs = Number(url.searchParams.get("timeout") ?? 600000);
        const arr = channels.get(channel) ?? [];
        const existing = arr.find((f) => f.id > since && !f.internal);
        if (existing) return Response.json({ fragment: existing });
        const fragment = await new Promise<Fragment | null>((resolve) => {
          const t = setTimeout(() => {
            unsub();
            resolve(null);
          }, timeoutMs);
          const unsub = subscribe(channel, (e) => {
            if (e.type === "fragment" && e.fragment.id > since && !e.fragment.internal) {
              clearTimeout(t);
              unsub();
              resolve(e.fragment);
            }
          });
          req.signal.addEventListener("abort", () => {
            clearTimeout(t);
            unsub();
            resolve(null);
          });
        });
        if (!fragment) return new Response("timeout", { status: 408 });
        return Response.json({ fragment });
      }

      // POST /:channel/permission — body is Markdown; long-polls until /decide/:id arrives.
      // Returns {decision, message?} or 408 timeout.
      const permMatch = p.match(/^\/([^/]+)\/permission$/);
      if (permMatch && req.method === "POST") {
        const channel = decodeURIComponent(permMatch[1]!);
        const md = await req.text();
        if (!md.trim()) return new Response("empty", { status: 400 });
        const timeoutMs = Number(url.searchParams.get("timeout") ?? 600000);
        const internal = url.searchParams.get("internal") !== "0";
        const f = append(channel, md, true, internal);
        const decision = await new Promise<{ value: string; message?: string; remember?: boolean } | null>(
          (resolve) => {
            const t = setTimeout(() => {
              pendings.delete(f.id);
              resolve(null);
            }, timeoutMs);
            pendings.set(f.id, {
              resolve: (d) => {
                clearTimeout(t);
                pendings.delete(f.id);
                resolve(d);
              },
            });
            req.signal.addEventListener("abort", () => {
              clearTimeout(t);
              pendings.delete(f.id);
              resolve(null);
            });
          },
        );
        if (!decision) {
          resolveAwaiting(channel, f.id, "deny", "timeout");
          return new Response("timeout", { status: 408 });
        }
        resolveAwaiting(channel, f.id, decision.value, decision.message);
        return Response.json({ id: f.id, ...decision });
      }

      // POST /:channel/gate?key=&wait=&timeout=&auto=allow|deny — generic two-phase gate.
      // Posts a fragment immediately; if a /signal with the same key arrives within `wait` ms,
      // the fragment is escalated to require a user decision; otherwise resolves with `auto`.
      //
      // Body: markdown (default) OR application/json with `{ markdown, actions? }`.
      // `actions` is an array of `{ label, value, color?, ...extra }` objects rendered
      // as buttons in the UI. The chosen action's full payload is returned as the gate's
      // response so callers can attach freeform metadata (remember, scope, ...).
      const gateMatch = p.match(/^\/([^/]+)\/gate$/);
      if (gateMatch && req.method === "POST") {
        const channel = decodeURIComponent(gateMatch[1]!);
        const ctype = req.headers.get("content-type") ?? "";
        let md = "";
        let actions: GateAction[] | undefined;
        if (ctype.includes("application/json")) {
          const body = (await req.json().catch(() => null)) as
            | { markdown?: string; actions?: GateAction[] }
            | null;
          md = body?.markdown ?? "";
          actions = Array.isArray(body?.actions) ? body!.actions : undefined;
        } else {
          md = await req.text();
        }
        if (!md.trim()) return new Response("empty", { status: 400 });
        const key = url.searchParams.get("key") ?? "";
        if (!key) return new Response("missing key", { status: 400 });
        const waitMs = Number(url.searchParams.get("wait") ?? 300);
        const timeoutMs = Number(url.searchParams.get("timeout") ?? 600000);
        const auto = (url.searchParams.get("auto") ?? "allow") === "deny" ? "deny" : "allow";
        const internal = url.searchParams.get("internal") !== "0";
        const f = append(channel, md, false, internal);
        if (actions && actions.length) f.actions = actions;

        // Phase 1: wait for a /signal on the same key, up to waitMs.
        const signaled = await new Promise<{ extraMd?: string } | null>((resolve) => {
          const t = setTimeout(() => {
            if (gates.get(key)?.fragmentId === f.id) gates.delete(key);
            resolve(null);
          }, waitMs);
          gates.set(key, {
            channel,
            fragmentId: f.id,
            onSignal: (extraMd) => {
              clearTimeout(t);
              if (gates.get(key)?.fragmentId === f.id) gates.delete(key);
              resolve({ extraMd });
            },
          });
          req.signal.addEventListener("abort", () => {
            clearTimeout(t);
            if (gates.get(key)?.fragmentId === f.id) gates.delete(key);
            resolve(null);
          });
        });

        if (!signaled) {
          return Response.json({ id: f.id, value: auto, auto: true });
        }

        // Phase 2: escalate fragment to awaiting and block for /decide.
        if (signaled.extraMd && signaled.extraMd.trim()) {
          f.markdown = `${f.markdown}\n\n${signaled.extraMd}`;
        }
        f.awaiting = true;
        emit(channel, { type: "awaiting", id: f.id, markdown: f.markdown, actions: f.actions });

        const decision = await new Promise<DecisionPayload | null>(
          (resolve) => {
            const t = setTimeout(() => {
              pendings.delete(f.id);
              resolve(null);
            }, timeoutMs);
            pendings.set(f.id, {
              actions: f.actions,
              resolve: (d) => {
                clearTimeout(t);
                pendings.delete(f.id);
                resolve(d);
              },
            });
            req.signal.addEventListener("abort", () => {
              clearTimeout(t);
              pendings.delete(f.id);
              resolve(null);
            });
          },
        );
        if (!decision) {
          resolveAwaiting(channel, f.id, "deny", "timeout");
          return new Response("timeout", { status: 408 });
        }
        resolveAwaiting(channel, f.id, decision.value, decision.message);
        return Response.json({ id: f.id, ...decision });
      }

      // POST /:channel/signal?key= — escalate any pending /gate for this key.
      const signalMatch = p.match(/^\/([^/]+)\/signal$/);
      if (signalMatch && req.method === "POST") {
        const key = url.searchParams.get("key") ?? "";
        if (!key) return new Response("missing key", { status: 400 });
        const extra = await req.text();
        const g = gates.get(key);
        if (!g) return Response.json({ ok: false, matched: false });
        g.onSignal(extra || undefined);
        return Response.json({ ok: true, matched: true, id: g.fragmentId });
      }

      // POST /:channel/decide/:id — browser sends a decision
      const decideMatch = p.match(/^\/([^/]+)\/decide\/(\d+)$/);
      if (decideMatch && req.method === "POST") {
        const id = Number(decideMatch[2]);
        const body = (await req.json().catch(() => null)) as
          | (DecisionPayload & { actionIndex?: number })
          | null;
        const pend = pendings.get(id);
        if (!pend) return new Response("no pending", { status: 404 });
        // If the client sent an actionIndex, resolve to that action's full payload.
        // Otherwise expect an explicit decision.
        let payload: DecisionPayload | null = null;
        if (body && typeof body.actionIndex === "number" && pend.actions?.[body.actionIndex]) {
          const a = pend.actions[body.actionIndex]!;
          payload = { ...a, value: a.value };
        } else if (body && typeof body.value === "string" && body.value) {
          payload = body as DecisionPayload;
        }
        if (!payload) return new Response("bad value", { status: 400 });
        pend.resolve(payload);
        return Response.json({ ok: true });
      }

      // POST /:channel/ephemeral?key=KEY — set or clear an ephemeral message.
      // Body is Markdown; empty body clears that key. Omitting key clears all
      // ephemerals for the channel.
      const ephemeralMatch = p.match(/^\/([^/]+)\/ephemeral$/);
      if (ephemeralMatch && req.method === "POST") {
        const channel = decodeURIComponent(ephemeralMatch[1]!);
        const key = url.searchParams.get("key") ?? "";
        const animation = url.searchParams.get("animation") ?? "typing";
        const body = await req.text();
        const cleared = body.trim() === "";
        if (!key) {
          if (cleared) clearAllEphemerals(channel);
          else return new Response("missing key", { status: 400 });
        } else {
          setEphemeral(channel, key, cleared ? null : body, animation);
        }
        return Response.json({ ok: true, key, markdown: cleared ? null : body, animation });
      }

      // GET /:channel — fragments JSON, or HTML if browser
      const channelMatch = p.match(/^\/([^/]+)$/);
      if (channelMatch && req.method === "GET") {
        const wantsHtml = (req.headers.get("accept") ?? "").includes("text/html");
        if (wantsHtml) {
          return new Response(Bun.file(join(PUBLIC, "index.html")), {
            headers: {
              "content-type": "text/html; charset=utf-8",
              ...securityHeaders,
            },
          });
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
            let closed = false;
            let unsub: (() => void) | null = null;
            const cleanup = () => {
              if (closed) return;
              closed = true;
              unsub?.();
              try { controller.close(); } catch {}
            };
            const safeEnqueue = (chunk: Uint8Array) => {
              if (closed) return;
              try { controller.enqueue(chunk); }
              catch { cleanup(); }
            };
            for (const f of channels.get(channel) ?? []) {
              safeEnqueue(enc.encode(`data: ${JSON.stringify({ type: "fragment", fragment: f })}\n\n`));
            }
            const curMap = ephemerals.get(channel);
            if (curMap) {
              for (const [key, val] of curMap) {
                safeEnqueue(enc.encode(`data: ${JSON.stringify({ type: "ephemeral", channel, key, markdown: val.markdown, animation: val.animation })}\n\n`));
              }
            }
            unsub = subscribe(channel, (e) => {
              safeEnqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
            });
            if (closed) unsub();
            req.signal.addEventListener("abort", cleanup);
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
