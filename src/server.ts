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

type MetaEvent =
  | { type: "channel.created"; channel: string }
  | { type: "channel.appended"; channel: string; id: number }
  | { type: "supplier.added"; namespaces: { prefix: string; label: string }[] }
  | { type: "supplier.removed"; namespaces: { prefix: string; label: string }[] };

const metaSubscribers = new Set<(e: MetaEvent) => void>();
function emitMeta(e: MetaEvent) {
  for (const cb of metaSubscribers) cb(e);
}

type Supplier = {
  id: string;
  namespaces: { prefix: string; label: string }[];
  lastSeen: number;
};
const suppliers = new Map<string, Supplier>();
const SUPPLIER_TTL = 30_000;
function pruneSuppliers() {
  const now = Date.now();
  for (const [id, s] of suppliers) {
    if (now - s.lastSeen > SUPPLIER_TTL) {
      suppliers.delete(id);
      emitMeta({ type: "supplier.removed", namespaces: s.namespaces });
    }
  }
}
setInterval(pruneSuppliers, 5_000).unref?.();

function aggregatedNamespaces(): { prefix: string; label: string }[] {
  pruneSuppliers();
  const seen = new Map<string, string>();
  for (const s of suppliers.values()) {
    for (const ns of s.namespaces) {
      if (!seen.has(ns.prefix)) seen.set(ns.prefix, ns.label);
    }
  }
  return [...seen.entries()].map(([prefix, label]) => ({ prefix, label }));
}

const ACTION_SUFFIXES = ["append", "wait", "permission", "gate", "signal", "ephemeral", "stream", "upload"] as const;
type Action = (typeof ACTION_SUFFIXES)[number] | "decide";

function parseChannelAction(p: string): { channel: string; action: Action; id?: number } | null {
  if (!p.startsWith("/") || p.length < 2) return null;
  const path = p.slice(1);
  const decideM = path.match(/^(.+)\/decide\/(\d+)$/);
  if (decideM) {
    const ch = decodeURIComponent(decideM[1]!);
    if (ch) return { channel: ch, action: "decide", id: Number(decideM[2]) };
  }
  for (const a of ACTION_SUFFIXES) {
    if (path.endsWith("/" + a)) {
      const ch = path.slice(0, -a.length - 1);
      if (ch) return { channel: decodeURIComponent(ch), action: a };
    }
  }
  return null;
}

function emit(channel: string, e: Event) {
  for (const cb of subscribers.get(channel) ?? []) cb(e);
}

const MAX_FRAGMENTS_PER_CHANNEL = 500;

function append(channel: string, markdown: string, awaiting = false, internal = false): Fragment {
  const f: Fragment = { id: nextId++, channel, ts: Date.now(), markdown };
  if (awaiting) f.awaiting = true;
  if (internal) f.internal = true;
  const existed = channels.has(channel);
  const arr = channels.get(channel) ?? [];
  arr.push(f);
  if (arr.length > MAX_FRAGMENTS_PER_CHANNEL) {
    arr.splice(0, arr.length - MAX_FRAGMENTS_PER_CHANNEL);
  }
  channels.set(channel, arr);
  if (!existed) emitMeta({ type: "channel.created", channel });
  emitMeta({ type: "channel.appended", channel, id: f.id });
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

function metaStream(
  req: Request,
  filter: MetaEvent["type"][],
  initial?: () => unknown,
) {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        metaSubscribers.delete(cb);
        try { controller.close(); } catch {}
      };
      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try { controller.enqueue(chunk); }
        catch { cleanup(); }
      };
      if (initial) {
        safeEnqueue(enc.encode(`data: ${JSON.stringify(initial())}\n\n`));
      }
      const cb = (e: MetaEvent) => {
        if (!filter.includes(e.type)) return;
        safeEnqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      };
      metaSubscribers.add(cb);
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

export function serve(port: number, hostname?: string) {
  return Bun.serve({
    port,
    ...(hostname ? { hostname } : {}),
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

      // GET /channels/stream — SSE for channel meta events
      if (p === "/channels/stream" && req.method === "GET") {
        return metaStream(req, ["channel.created", "channel.appended"]);
      }

      // GET /namespaces — supplier-announced namespace list
      if (p === "/namespaces" && req.method === "GET") {
        return Response.json(aggregatedNamespaces());
      }

      // GET /namespaces/stream — SSE for namespace registry changes
      if (p === "/namespaces/stream" && req.method === "GET") {
        return metaStream(req, ["supplier.added", "supplier.removed"], () => ({
          type: "namespaces",
          namespaces: aggregatedNamespaces(),
        }));
      }

      // POST /suppliers/:id/announce — register/heartbeat a supplier
      const announceMatch = p.match(/^\/suppliers\/([^/]+)\/announce$/);
      if (announceMatch && req.method === "POST") {
        const id = decodeURIComponent(announceMatch[1]!);
        const body = (await req.json().catch(() => null)) as
          | { namespaces?: { prefix?: string; label?: string }[] }
          | null;
        const namespaces = (body?.namespaces ?? [])
          .filter((n) => typeof n?.prefix === "string" && n.prefix && /^[a-z0-9][a-z0-9-]*$/i.test(n.prefix))
          .map((n) => ({ prefix: n.prefix!, label: n.label || n.prefix! }));
        const prev = suppliers.get(id);
        suppliers.set(id, { id, namespaces, lastSeen: Date.now() });
        if (!prev) emitMeta({ type: "supplier.added", namespaces });
        else if (JSON.stringify(prev.namespaces) !== JSON.stringify(namespaces)) {
          emitMeta({ type: "supplier.removed", namespaces: prev.namespaces });
          emitMeta({ type: "supplier.added", namespaces });
        }
        return Response.json({ ok: true, ttl: SUPPLIER_TTL });
      }

      // GET /uploads/:channel/:file — serve uploaded files (so <img> works in markdown).
      const uploadFileMatch = p.match(/^\/uploads\/([^/]+)\/([^/]+)$/);
      if (uploadFileMatch && req.method === "GET") {
        const ch = decodeURIComponent(uploadFileMatch[1]!).replace(/[^A-Za-z0-9._-]/g, "_");
        const name = decodeURIComponent(uploadFileMatch[2]!);
        if (name.includes("..") || name.includes("/")) return new Response("bad path", { status: 400 });
        return new Response(Bun.file(join(UPLOADS, ch, name)));
      }

      const ca = parseChannelAction(p);

      // POST /:channel/upload — multipart upload; saves files locally and returns
      // both an absolute filesystem path (for Claude / shell tools) and an http
      // URL (so the GUI can render the file inline).
      if (ca?.action === "upload" && req.method === "POST") {
        const channel = ca.channel;
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
      if (ca?.action === "append" && req.method === "POST") {
        const channel = ca.channel;
        const md = await req.text();
        if (!md.trim()) return new Response("empty", { status: 400 });
        const internal = url.searchParams.get("internal") === "1";
        const f = append(channel, md, false, internal);
        return Response.json({ ok: true, id: f.id });
      }

      // GET /:channel/wait?since=<id>&timeout=<ms> — long-poll for the next fragment with id > since
      if (ca?.action === "wait" && req.method === "GET") {
        const channel = ca.channel;
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
      if (ca?.action === "permission" && req.method === "POST") {
        const channel = ca.channel;
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
      if (ca?.action === "gate" && req.method === "POST") {
        const channel = ca.channel;
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
      if (ca?.action === "signal" && req.method === "POST") {
        const key = url.searchParams.get("key") ?? "";
        if (!key) return new Response("missing key", { status: 400 });
        const extra = await req.text();
        const g = gates.get(key);
        if (!g) return Response.json({ ok: false, matched: false });
        g.onSignal(extra || undefined);
        return Response.json({ ok: true, matched: true, id: g.fragmentId });
      }

      // POST /:channel/decide/:id — browser sends a decision
      if (ca?.action === "decide" && req.method === "POST") {
        const id = ca.id!;
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
      if (ca?.action === "ephemeral" && req.method === "POST") {
        const channel = ca.channel;
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

      // GET /:channel/stream — SSE (multi-segment supported)
      if (ca?.action === "stream" && req.method === "GET") {
        const channel = ca.channel;
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

      // GET /<channel...> — fragments JSON or HTML shell. Multi-segment supported.
      if (req.method === "GET" && p.length > 1 && !ca) {
        const first = p.split("/", 2)[1] ?? "";
        const reserved = new Set(["channels", "namespaces", "suppliers", "uploads", "app.js", "index.css", "index.html"]);
        if (reserved.has(first) || first.startsWith("app-")) {
          return new Response("not found", { status: 404 });
        }
        const wantsHtml = (req.headers.get("accept") ?? "").includes("text/html");
        if (wantsHtml) {
          return new Response(Bun.file(join(PUBLIC, "index.html")), {
            headers: {
              "content-type": "text/html; charset=utf-8",
              ...securityHeaders,
            },
          });
        }
        const channel = decodeURIComponent(p.slice(1));
        const frags = channels.get(channel) ?? [];
        return Response.json(frags);
      }

      return new Response("not found", { status: 404 });
    },
  });
}
