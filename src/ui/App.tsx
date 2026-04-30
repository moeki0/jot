import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import swift from "highlight.js/lib/languages/swift";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import ini from "highlight.js/lib/languages/ini";
import markdown from "highlight.js/lib/languages/markdown";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import DOMPurify from "dompurify";
import { Settings as SettingsIcon, Copy as CopyIcon, Check as CheckIcon } from "lucide-react";

for (const [name, lang] of [
  ["bash", bash], ["javascript", javascript], ["typescript", typescript],
  ["tsx", typescript], ["python", python], ["ruby", ruby], ["go", go],
  ["rust", rust], ["swift", swift], ["json", json], ["yaml", yaml],
  ["ini", ini], ["markdown", markdown], ["xml", xml], ["css", css],
  ["scss", scss], ["sql", sql],
] as const) {
  hljs.registerLanguage(name, lang as any);
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function rewriteUploadPath(src: string): string {
  // Rewrite absolute filesystem paths under .jot/uploads/<channel>/<file> to
  // the HTTP route the Bun server serves them from.
  const m = src.match(/(?:^|\/)\.jot\/uploads\/([^/]+)\/([^/]+)$/);
  if (m) return `/uploads/${encodeURIComponent(m[1]!)}/${encodeURIComponent(m[2]!)}`;
  return src;
}

type DiffLine = { kind: "add" | "del" | "hunk" | "ctx" | "empty"; text: string };
type DiffParts = Array<{ changed: boolean; text: string }>;

function tokenizeForDiff(s: string): string[] {
  return s.match(/\s+|[A-Za-z0-9_]+|[^\s\w]/g) ?? [];
}

function wordDiff(a: string, b: string): [DiffParts, DiffParts] {
  const at = tokenizeForDiff(a);
  const bt = tokenizeForDiff(b);
  const n = at.length, m = bt.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = at[i] === bt[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const aParts: DiffParts = [];
  const bParts: DiffParts = [];
  const push = (arr: DiffParts, changed: boolean, text: string) => {
    const last = arr[arr.length - 1];
    if (last && last.changed === changed) last.text += text;
    else arr.push({ changed, text });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (at[i] === bt[j]) { push(aParts, false, at[i]!); push(bParts, false, bt[j]!); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { push(aParts, true, at[i]!); i++; }
    else { push(bParts, true, bt[j]!); j++; }
  }
  while (i < n) push(aParts, true, at[i++]!);
  while (j < m) push(bParts, true, bt[j++]!);
  return [aParts, bParts];
}

function renderDiff(text: string, innerLang: string | null): string {
  const raw = text.replace(/\n+$/, "");
  const lines: DiffLine[] = raw.split("\n").map((l) => {
    if (l === "") return { kind: "empty", text: "" };
    if (l.startsWith("@")) return { kind: "hunk", text: l };
    if (l.startsWith("+")) return { kind: "add", text: l.slice(1) };
    if (l.startsWith("-")) return { kind: "del", text: l.slice(1) };
    return { kind: "ctx", text: l.startsWith(" ") ? l.slice(1) : l };
  });

  const intra = new Map<number, DiffParts>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.kind === "del") {
      const dStart = i;
      while (i < lines.length && lines[i]!.kind === "del") i++;
      const dEnd = i;
      const aStart = i;
      while (i < lines.length && lines[i]!.kind === "add") i++;
      const aEnd = i;
      const pairs = Math.min(dEnd - dStart, aEnd - aStart);
      for (let k = 0; k < pairs; k++) {
        const [dParts, aParts] = wordDiff(lines[dStart + k]!.text, lines[aStart + k]!.text);
        intra.set(dStart + k, dParts);
        intra.set(aStart + k, aParts);
      }
    } else {
      i++;
    }
  }

  const renderBody = (kind: DiffLine["kind"], lineText: string, parts: DiffParts | undefined): string => {
    if (parts) {
      const strongCls = kind === "add" ? "diff-add-strong" : "diff-del-strong";
      return parts.map((p) => {
        const esc = escapeHtml(p.text);
        return p.changed ? `<span class="${strongCls}">${esc}</span>` : esc;
      }).join("");
    }
    if (innerLang && (kind === "add" || kind === "del" || kind === "ctx")) {
      return hljs.highlight(lineText, { language: innerLang, ignoreIllegals: true }).value;
    }
    return escapeHtml(lineText);
  };

  const out = lines.map((line, idx) => {
    const cls = line.kind === "add" ? "diff-add" : line.kind === "del" ? "diff-del" : line.kind === "hunk" ? "diff-hunk" : "";
    const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : line.kind === "ctx" ? " " : "";
    if (line.kind === "hunk") {
      return `<span class="${cls}">${escapeHtml(line.text) || " "}</span>`;
    }
    if (line.kind === "empty") {
      return `<span> </span>`;
    }
    const body = renderBody(line.kind, line.text, intra.get(idx));
    const inner = `${escapeHtml(marker)}${body || " "}`;
    return cls ? `<span class="${cls}">${inner}</span>` : `<span>${inner}</span>`;
  });
  return `<pre class="diff"><code>${out.join("")}</code></pre>`;
}

marked.use({
  renderer: {
    image({ href, title, text }) {
      const src = rewriteUploadPath(href);
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text || "")}"${t} />`;
    },
    code({ text, lang }) {
      const diffMatch = lang && lang.match(/^diff(?:[:\-](.+))?$/);
      if (diffMatch) {
        const inner = diffMatch[1];
        const innerLang = inner && hljs.getLanguage(inner) ? inner : null;
        return renderDiff(text, innerLang);
      }
      if (lang && hljs.getLanguage(lang)) {
        const html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
        return `<pre><code class="hljs language-${escapeHtml(lang)}">${html}</code></pre>`;
      }
      const langCls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      return `<pre><code${langCls}>${escapeHtml(text)}</code></pre>`;
    },
  },
});

function parseBashToolCall(md: string): { command: string } | null {
  const m = md.match(/^> \*\*Bash\*\*\s*\n\n```bash\n([\s\S]*?)\n```\s*$/);
  if (!m) return null;
  return { command: m[1]! };
}

const QUESTION_ITEM_RE = /^\s*[-*]\s+(?:(Option|選択肢)\s+(\S+):\s*(.+)|(Yes|No|はい|いいえ)(?::\s*(.+))?)\s*$/;

type QuestionOption = { label: string; description?: string };

type Segment =
  | { kind: "text"; markdown: string }
  | { kind: "question"; prompt: string; options: QuestionOption[] };

function parseSegments(md: string): Segment[] {
  const lines = md.split("\n");
  const segments: Segment[] = [];
  let i = 0;
  let textStart = 0;

  const flushText = (upto: number) => {
    const slice = lines.slice(textStart, upto).join("\n");
    if (slice.trim() !== "") segments.push({ kind: "text", markdown: slice });
  };

  while (i < lines.length) {
    if (/^\s*[-*]\s/.test(lines[i]!)) {
      let listEnd = i;
      while (listEnd < lines.length && /^\s*[-*]\s/.test(lines[listEnd]!)) listEnd++;
      const items = lines.slice(i, listEnd);
      const matches = items.map((l) => l.match(QUESTION_ITEM_RE));
      if (matches.every(Boolean)) {
        // Extract trailing paragraph from preceding text as prompt
        const preceding = lines.slice(textStart, i);
        let promptStart = preceding.length;
        let sawContent = false;
        for (let j = preceding.length - 1; j >= 0; j--) {
          if (preceding[j]!.trim() === "") {
            if (sawContent) break;
            continue;
          }
          sawContent = true;
          promptStart = j;
        }
        const beforeText = preceding.slice(0, promptStart).join("\n");
        if (beforeText.trim() !== "") segments.push({ kind: "text", markdown: beforeText });
        const promptLines = preceding.slice(promptStart).filter((l) => l.trim() !== "");
        const options: QuestionOption[] = matches.map((m) => {
          const optKw = m![1];
          const id = m![2];
          const optDesc = m![3];
          const yesNoKw = m![4];
          const ynDesc = m![5];
          if (optKw) return { label: `${optKw} ${id}`, description: optDesc };
          return { label: yesNoKw!, description: ynDesc };
        });
        segments.push({ kind: "question", prompt: promptLines.join("\n").trim(), options });
        i = listEnd;
        textStart = i;
        continue;
      }
      i = listEnd;
      continue;
    }
    i++;
  }

  flushText(lines.length);
  return segments;
}

function renderMarkdown(md: string): string {
  const dirty = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS: ["a","abbr","b","blockquote","br","code","del","div","em","h1","h2","h3","h4","h5","h6","hr","img","li","ol","p","pre","s","span","strong","table","tbody","td","th","thead","tr","ul"],
    ALLOWED_ATTR: ["href","title","src","alt","align","class"],
  });
}

type GateAction = { label: string; value: string; color?: string; [key: string]: unknown };

type Fragment = {
  id: number;
  channel: string;
  ts: number;
  markdown: string;
  awaiting?: boolean;
  internal?: boolean;
  actions?: GateAction[];
};

type Event =
  | { type: "fragment"; fragment: Fragment }
  | { type: "ephemeral"; channel: string; key: string; markdown: string | null; animation?: string }
  | { type: "awaiting"; id: number; markdown?: string; actions?: GateAction[] }
  | { type: "decided"; id: number; value: string; message?: string };

const fmtTime = (ts: number) => {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

function getInitialChannel() {
  const c = decodeURIComponent(location.pathname.replace(/^\//, "")) || "default";
  if (location.pathname === "/") history.replaceState(null, "", "/" + c);
  return c;
}

const chPath = (ch: string) => ch.split("/").map(encodeURIComponent).join("/");

function useSettings() {
  const defs = {
    font: { default: "sans", values: ["sans", "serif", "mono"] },
    theme: { default: "light", values: ["light", "sepia", "dark"] },
    size: { default: "m", values: ["xs", "s", "m", "l", "xl"] },
  } as const;
  type Name = keyof typeof defs;
  const [values, setValues] = useState<Record<Name, string>>(() => {
    const out: any = {};
    for (const k of Object.keys(defs) as Name[]) {
      let v = defs[k].default as string;
      try { v = localStorage.getItem(`jot.${k}`) || v; } catch {}
      if (!(defs[k].values as readonly string[]).includes(v)) v = defs[k].default;
      out[k] = v;
    }
    return out;
  });
  useEffect(() => {
    for (const [k, v] of Object.entries(values)) {
      document.documentElement.setAttribute(`data-${k}`, v);
      try { localStorage.setItem(`jot.${k}`, v); } catch {}
    }
  }, [values]);
  return { values, defs, set: (k: Name, v: string) => setValues((s) => ({ ...s, [k]: v })) };
}

export function App() {
  const [channel] = useState(getInitialChannel);
  const [fragments, setFragments] = useState<Fragment[]>([]);
  const [ephemerals, setEphemerals] = useState<Record<string, { markdown: string; animation: string }>>({});
  const [unread, setUnread] = useState<Set<number>>(() => new Set());
  const [, setLive] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState<null | "channels" | "settings">(null);
  const [channels, setChannels] = useState<{ name: string; count: number }[]>([]);
  const fragmentRefs = useRef(new Map<number, HTMLElement>());
  const seenRef = useRef(new Set<number>());
  const readyRef = useRef(false);
  const didInitialScrollRef = useRef(false);
  const settings = useSettings();

  const markReady = () => {
    if (readyRef.current) return;
    readyRef.current = true;
    if (!didInitialScrollRef.current) {
      didInitialScrollRef.current = true;
      requestAnimationFrame(() => {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
      });
    }
  };

  // SSE connection
  useEffect(() => {
    let es: EventSource | null = null;
    let backlogTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let aborted = false;

    const connect = () => {
      if (aborted) return;
      es = new EventSource(`/${chPath(channel)}/stream`);
      es.onopen = () => {
        setLive(true);
        if (backlogTimer) clearTimeout(backlogTimer);
        backlogTimer = setTimeout(markReady, 250);
      };
      es.onmessage = (e) => {
        try {
          const ev: Event = JSON.parse(e.data);
          if (ev.type === "fragment") {
            const f = ev.fragment;
            if (seenRef.current.has(f.id)) return;
            seenRef.current.add(f.id);
            setFragments((prev) => [...prev, f]);
            if (readyRef.current) {
              setUnread((u) => { const n = new Set(u); n.add(f.id); return n; });
            }
          } else if (ev.type === "ephemeral") {
            setEphemerals((prev) => {
              const next = { ...prev };
              if (ev.markdown === null) delete next[ev.key];
              else next[ev.key] = { markdown: ev.markdown, animation: ev.animation ?? "typing" };
              return next;
            });
          } else if (ev.type === "awaiting") {
            setFragments((prev) => prev.map((f) =>
              f.id === ev.id ? { ...f, awaiting: true, markdown: ev.markdown ?? f.markdown, actions: ev.actions ?? f.actions } : f
            ));
          } else if (ev.type === "decided") {
            setFragments((prev) => prev.map((f) =>
              f.id === ev.id ? { ...f, awaiting: false } : f
            ));
          }
          if (backlogTimer) clearTimeout(backlogTimer);
          backlogTimer = setTimeout(markReady, 250);
        } catch {}
      };
      es.onerror = () => {
        setLive(false);
        try { es?.close(); } catch {}
        es = null;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      aborted = true;
      try { es?.close(); } catch {}
      if (backlogTimer) clearTimeout(backlogTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [channel]);

  // intersection observer for unread tracking
  useEffect(() => {
    const obs = new IntersectionObserver((entries) => {
      let changed = false;
      const newUnread = new Set(unread);
      for (const e of entries) {
        if (e.isIntersecting) {
          const id = Number((e.target as HTMLElement).dataset.id);
          if (newUnread.delete(id)) changed = true;
          obs.unobserve(e.target);
        }
      }
      if (changed) setUnread(newUnread);
    }, { threshold: 0, rootMargin: "0px 0px -50px 0px" });
    for (const id of unread) {
      const el = fragmentRefs.current.get(id);
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
  }, [unread]);

  const visibleFragments = fragments;

  // Preserve scroll position relative to the composer while the user is typing.
  const prevHeightRef = useRef(0);
  useLayoutEffect(() => {
    const prev = prevHeightRef.current;
    const next = document.documentElement.scrollHeight;
    prevHeightRef.current = next;
    const active = document.activeElement as HTMLElement | null;
    const typing = active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT" || active.isContentEditable);
    if (typing && prev && next > prev) {
      window.scrollBy({ top: next - prev, behavior: "auto" });
    }
  }, [fragments.length]);

  const decide = useCallback(async (id: number, payload: { value: string; [k: string]: unknown } | { actionIndex: number }) => {
    try {
      await fetch(`/${chPath(channel)}/decide/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {}
  }, [channel]);

  const INGEST_CHANNEL = "claude-code";
  const submitMessage = useCallback<(md: string) => Promise<boolean>>(async (md: string) => {
    if (!md.trim()) return false;
    try {
      await fetch(`/${chPath(channel)}/append`, {
        method: "POST",
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: md,
      });
      // Mirror to the harness-monitored channel so Claude actually sees it,
      // wrapped with a channel hint so the hook resolver routes the reply back.
      if (channel !== INGEST_CHANNEL) {
        const wrapped = `<jot-route channel="${channel}" />\n${md}`;
        fetch(`/${encodeURIComponent(INGEST_CHANNEL)}/append`, {
          method: "POST",
          headers: { "content-type": "text/plain; charset=utf-8" },
          body: wrapped,
        }).catch(() => {});
      }
      // Scroll the freshly-sent fragment to ~100px from the viewport top.
      // The fragment arrives via SSE asynchronously; wait for it then scrollIntoView
      // (CSS scroll-margin-top on .fragment provides the 100px offset).
      const startCount = document.querySelectorAll(".fragment").length;
      let tries = 0;
      const tick = () => {
        const fragments = document.querySelectorAll<HTMLElement>(".fragment");
        if (fragments.length > startCount) {
          const last = fragments[fragments.length - 1]!;
          last.scrollIntoView({ behavior: "smooth", block: "start" });
          return;
        }
        if (tries++ > 60) return;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return true;
    } catch {
      return false;
    }
  }, [channel]);

  const fetchChannels = useCallback(async () => {
    try {
      const r = await fetch("/channels");
      const list = await r.json();
      setChannels(list);
    } catch {}
  }, []);

  // emacs keybindings
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key === "Escape") { setOverlayOpen(null); return; }
      if (e.key === "k" && e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setOverlayOpen((o) => {
          if (o === "channels") return null;
          fetchChannels();
          return "channels";
        });
        return;
      }
      const editable = target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable);
      if (editable) return;
      if (e.metaKey) return;
      const fragsList = () => Array.from(document.querySelectorAll<HTMLElement>(".fragment"));
      const nearestIdx = () => {
        const list = fragsList();
        if (!list.length) return -1;
        const mid = innerHeight / 2;
        let best = 0, bd = Infinity;
        list.forEach((el, i) => {
          const r = el.getBoundingClientRect();
          const d = Math.abs((r.top + r.bottom) / 2 - mid);
          if (d < bd) { bd = d; best = i; }
        });
        return best;
      };
      if (e.ctrlKey && !e.altKey) {
        if (e.key === "n" || e.key === "p") {
          e.preventDefault();
          const list = fragsList();
          if (!list.length) return;
          const i = Math.max(0, Math.min(list.length - 1, nearestIdx() + (e.key === "n" ? 1 : -1)));
          list[i]?.scrollIntoView({ behavior: "smooth", block: "start" });
          return;
        }
        if (e.key === "v") { e.preventDefault(); scrollBy({ top: innerHeight * 0.9, behavior: "smooth" }); return; }
        if (e.key === "g") { e.preventDefault(); setOverlayOpen(null); return; }
        if (e.key === "l") {
          e.preventDefault();
          const list = fragsList();
          const i = nearestIdx();
          if (i >= 0) list[i]?.scrollIntoView({ behavior: "smooth", block: "center" });
          return;
        }
      }
      if (e.altKey && !e.ctrlKey) {
        if (e.key === "v") { e.preventDefault(); scrollBy({ top: -innerHeight * 0.9, behavior: "smooth" }); return; }
        if (e.key === ">" || (e.shiftKey && e.key === ".")) {
          e.preventDefault();
          scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
          return;
        }
        if (e.key === "<" || (e.shiftKey && e.key === ",")) {
          e.preventDefault();
          scrollTo({ top: 0, behavior: "smooth" });
          return;
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [fetchChannels]);

  const channelButtonRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  const copyChannel = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(channel);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  }, [channel]);
  const toggleChannels = () => setOverlayOpen((o) => {
    if (o === "channels") return null;
    fetchChannels();
    return "channels";
  });
  const toggleSettings = () => setOverlayOpen((o) => (o === "settings" ? null : "settings"));

  const oldestUnread = unread.size ? Math.min(...unread) : null;
  const ephemeralEntries = Object.entries(ephemerals);
  const showBar = unread.size > 0;

  return (
    <>
      <header>
        <div className="header-left">
          <button ref={channelButtonRef} className="channel-button" onClick={toggleChannels} aria-haspopup="dialog">
            <span>{channel}</span>
            <span className="caret">▾</span>
          </button>
          <button className="icon-button" onClick={copyChannel} aria-label="copy channel id" title="copy channel id">
            {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
          </button>
        </div>
        <button className="icon-button" onClick={toggleSettings} aria-label="settings">
          <SettingsIcon size={16} />
        </button>
      </header>
      <main>
        <div id="stream">
          {visibleFragments.length === 0 ? (
            <div className="empty">
              <div>nothing yet on <strong>{channel}</strong></div>
              <code>{`echo "## hello" | curl -s --data-binary @- localhost:${location.port}/${channel}/append`}</code>
            </div>
          ) : visibleFragments.map((f) => (
            <FragmentView
              key={f.id}
              fragment={f}
              registerRef={(id, el) => {
                if (el) fragmentRefs.current.set(id, el);
                else fragmentRefs.current.delete(id);
              }}
              onDecide={decide}
              onChoice={submitMessage}
            />
          ))}
          {ephemeralEntries.length > 0 && (
            <article className="fragment ephemeral">
              <div className="ts" />
              <div className="body">
                {ephemeralEntries.map(([key, val], i) => (
                  <span key={key}>
                    {i > 0 && " · "}
                    <EphemeralLabel text={val.markdown} animation={val.animation} />
                  </span>
                ))}
              </div>
            </article>
          )}
        </div>
        <Composer onSubmit={submitMessage} channel={channel} />
      </main>
      {overlayOpen === "channels" && (
        <ChannelsDropdown
          channels={channels}
          current={channel}
          anchor={channelButtonRef.current}
          onClose={() => setOverlayOpen(null)}
        />
      )}
      <Overlay open={overlayOpen === "settings"} onClose={() => setOverlayOpen(null)}>
        <div className="sheet-title">appearance</div>
        <div className="settings">
          {(Object.keys(settings.defs) as Array<keyof typeof settings.defs>).map((k) => (
            <div key={k} className="setting-row">
              <span className="setting-label">{k}</span>
              <div className="setting-options">
                {(settings.defs[k]!.values as readonly string[]).map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={settings.values[k] === v ? "active" : ""}
                    onClick={() => settings.set(k, v)}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Overlay>
      {showBar && (
        <button
          className="status-bar show"
          onClick={() => {
            const el = oldestUnread != null ? fragmentRefs.current.get(oldestUnread) : null;
            if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
            else scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
          }}
        >
          {unread.size > 0 && `↓ ${unread.size} new`}
        </button>
      )}
    </>
  );
}

function FragmentView({
  fragment,
  registerRef,
  onDecide,
  onChoice,
}: {
  fragment: Fragment;
  registerRef: (id: number, el: HTMLElement | null) => void;
  onDecide: (id: number, payload: { value: string; [k: string]: unknown } | { actionIndex: number }) => void;
  onChoice: (md: string) => Promise<boolean>;
}) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    registerRef(fragment.id, ref.current);
    return () => registerRef(fragment.id, null);
  }, [fragment.id, registerRef]);

  const bashCall = useMemo(() => parseBashToolCall(fragment.markdown), [fragment.markdown]);
  const segments = useMemo(() => {
    if (bashCall) return null;
    const segs = parseSegments(fragment.markdown);
    return segs.some((s) => s.kind === "question") ? segs : null;
  }, [fragment.markdown, bashCall]);
  const html = useMemo(
    () => (bashCall || segments) ? "" : renderMarkdown(fragment.markdown),
    [fragment.markdown, bashCall, segments],
  );

  const questionCount = segments?.filter((s) => s.kind === "question").length ?? 0;
  const [answers, setAnswers] = useState<Map<number, { label: string; message: string }>>(new Map());
  const onPick = useCallback((segIdx: number, label: string, message: string) => {
    setAnswers((prev) => {
      if (prev.has(segIdx)) return prev;
      const next = new Map(prev);
      next.set(segIdx, { label, message });
      if (next.size === questionCount) {
        const combined = [...next.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, v]) => v.message)
          .join("\n\n---\n\n");
        void onChoice(combined);
      }
      return next;
    });
  }, [questionCount, onChoice]);

  return (
    <article className="fragment" data-id={fragment.id} ref={ref as any}>
      <div className="ts">{fmtTime(fragment.ts)}</div>
      {bashCall ? (
        <div className="body"><ToolCallCard name="Bash" command={bashCall.command} /></div>
      ) : segments ? (
        <div className="body">
          {segments.map((s, i) => s.kind === "question" ? (
            <QuestionCard
              key={i}
              prompt={s.prompt}
              options={s.options}
              chosenLabel={answers.get(i)?.label ?? null}
              onPick={(label, message) => onPick(i, label, message)}
            />
          ) : (
            <div key={i} dangerouslySetInnerHTML={{ __html: renderMarkdown(s.markdown) }} />
          ))}
        </div>
      ) : (
        <div className="body" dangerouslySetInnerHTML={{ __html: html }} />
      )}
      {fragment.awaiting && <PermissionBox actions={fragment.actions} onDecide={(p) => onDecide(fragment.id, p)} />}
    </article>
  );
}

function QuestionCard({ prompt, options, chosenLabel, onPick }: {
  prompt: string;
  options: QuestionOption[];
  chosenLabel: string | null;
  onPick: (label: string, message: string) => void;
}) {
  const chosen = chosenLabel;
  const [freeText, setFreeText] = useState("");
  const promptHtml = useMemo(() => prompt ? renderMarkdown(prompt) : "", [prompt]);
  const choose = (opt: QuestionOption) => {
    if (chosen) return;
    const isEnumerated = opt.label.startsWith("Option ") || opt.label.startsWith("選択肢 ");
    const primary = isEnumerated && opt.description ? opt.description : opt.label;
    const message = prompt
      ? `> ${prompt.split("\n").join("\n> ")}\n\n${primary}`
      : primary;
    onPick(opt.label, message);
  };
  const submitFree = () => {
    if (chosen) return;
    const text = freeText.trim();
    if (!text) return;
    const message = prompt
      ? `> ${prompt.split("\n").join("\n> ")}\n\n${text}`
      : text;
    onPick(text, message);
  };
  return (
    <div className="question-card">
      {prompt && <div className="question-prompt" dangerouslySetInnerHTML={{ __html: promptHtml }} />}
      <div className="question-options">
        {options.map((o, i) => {
          const picked = chosen === o.label;
          const dimmed = chosen != null && !picked;
          const isEnumerated = o.label.startsWith("Option ") || o.label.startsWith("選択肢 ");
          const badge = isEnumerated ? o.label.split(" ").slice(1).join(" ") : null;
          const primary = isEnumerated && o.description ? o.description : o.label;
          const subtitle = isEnumerated ? null : o.description;
          return (
            <button
              key={i}
              type="button"
              className={`question-button ${picked ? "picked" : ""} ${dimmed ? "dimmed" : ""}`}
              onClick={() => choose(o)}
              disabled={chosen != null}
              title={isEnumerated ? o.label : o.description}
            >
              {badge && <span className="question-badge">{badge}</span>}
              <span className="question-label">{primary}</span>
              {subtitle && <span className="question-desc">{subtitle}</span>}
            </button>
          );
        })}
      </div>
      <div className="question-free">
        <input
          type="text"
          className="question-free-input"
          placeholder="or type a free-form answer…"
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submitFree(); }}
          disabled={chosen != null}
        />
      </div>
    </div>
  );
}

function ToolCallCard({ name, command }: { name: string; command: string }) {
  const [open, setOpen] = useState(false);
  const firstLine = command.split("\n")[0] ?? "";
  const previewSrc = firstLine.length > 200 ? firstLine.slice(0, 199) + "…" : firstLine;
  const previewHtml = useMemo(
    () => hljs.highlight(previewSrc, { language: "bash", ignoreIllegals: true }).value,
    [previewSrc],
  );
  const fullHtml = useMemo(
    () => hljs.highlight(command, { language: "bash", ignoreIllegals: true }).value,
    [command],
  );
  return (
    <div className={`tool-call ${open ? "open" : ""}`}>
      <button type="button" className="tool-call-head" onClick={() => setOpen((o) => !o)}>
        <span className="tool-call-caret">{open ? "▾" : "▸"}</span>
        <span className="tool-call-name">{name}</span>
        <code className="tool-call-preview hljs language-bash" dangerouslySetInnerHTML={{ __html: previewHtml }} />
      </button>
      {open && (
        <pre className="tool-call-body"><code className="hljs language-bash" dangerouslySetInnerHTML={{ __html: fullHtml }} /></pre>
      )}
    </div>
  );
}

function EphemeralLabel({ text, animation }: { text: string; animation: string }) {
  if (animation === "typing") return <TypingLabel text={text} />;
  if (animation === "none") return <span className="ephemeral-label">{text}</span>;
  return <span className={`ephemeral-label ephemeral-anim-${animation}`}>{text}</span>;
}

function TypingLabel({ text }: { text: string }) {
  const [shown, setShown] = useState("");
  useEffect(() => {
    if (!text) { setShown(""); return; }
    let i = 0;
    let dir: 1 | -1 = 1;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (dir === 1) {
        i++;
        setShown(text.slice(0, i));
        if (i >= text.length) { dir = -1; t = setTimeout(tick, 1100); return; }
      } else {
        i--;
        setShown(text.slice(0, i));
        if (i <= 0) { dir = 1; t = setTimeout(tick, 450); return; }
      }
      const delay = dir === 1 ? 70 + Math.random() * 90 : 35 + Math.random() * 30;
      t = setTimeout(tick, delay);
    };
    t = setTimeout(tick, 100);
    return () => clearTimeout(t);
  }, [text]);
  return (
    <span className="kata-label">
      <span className="kata-text">{shown}</span>
      <span className="kata-caret" />
    </span>
  );
}

const DEFAULT_ACTIONS: GateAction[] = [
  { label: "Allow", value: "allow" },
  { label: "Deny", value: "deny" },
];

function PermissionBox({
  actions,
  onDecide,
}: {
  actions?: GateAction[];
  onDecide: (p: { value: string; [k: string]: unknown } | { actionIndex: number }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const list = actions && actions.length ? actions : DEFAULT_ACTIONS;
  return (
    <div className="perm">
      {list.map((a, i) => {
        const style = a.color
          ? { background: a.color, borderColor: a.color, color: "#fff" }
          : undefined;
        return (
          <button
            key={i}
            type="button"
            disabled={busy}
            style={style}
            onClick={() => {
              setBusy(true);
              if (actions && actions.length) onDecide({ actionIndex: i });
              else onDecide({ value: a.value });
            }}
          >{a.label}</button>
        );
      })}
    </div>
  );
}

function Composer({ onSubmit, channel }: { onSubmit: (md: string) => Promise<boolean>; channel: string }) {
  const [value, setValue] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches
  );
  useEffect(() => {
    const mq = window.matchMedia("(pointer: coarse)");
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  const autoSize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  };

  useEffect(autoSize, [value]);

  const submit = async () => {
    const md = value;
    if (!md.trim()) return;
    setValue("");
    const el = ref.current;
    el?.blur();
    (document.activeElement as HTMLElement | null)?.blur?.();
    setTimeout(() => {
      el?.blur();
      (document.activeElement as HTMLElement | null)?.blur?.();
    }, 0);
    const ok = await onSubmit(md);
    if (!ok) setValue(md);
    else el?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !(e.nativeEvent as any).isComposing && !isMobile) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "k") {
      e.preventDefault();
      const el = ref.current!;
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      const v = el.value;
      let next: string;
      let pos = start;
      if (start !== end) {
        next = v.slice(0, start) + v.slice(end);
      } else {
        const lineEnd = v.indexOf("\n", start);
        const cut = lineEnd === -1 ? v.length : (lineEnd === start ? start + 1 : lineEnd);
        next = v.slice(0, start) + v.slice(cut);
      }
      setValue(next);
      requestAnimationFrame(() => {
        if (ref.current) ref.current.selectionStart = ref.current.selectionEnd = pos;
      });
    }
  };

  const insertFormatted = (paths: string[]) => {
    const formatted = paths.map((p) => {
      const isImage = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(p);
      return isImage ? `![](<${p}>)` : p;
    }).join(" ") + " ";
    const el = ref.current!;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? start;
    setValue((v) => v.slice(0, start) + formatted + v.slice(end));
    requestAnimationFrame(() => {
      const pos = start + formatted.length;
      if (ref.current) {
        ref.current.focus();
        ref.current.selectionStart = ref.current.selectionEnd = pos;
      }
    });
  };

  const onDrop = async (e: React.DragEvent<HTMLTextAreaElement>) => {
    setDragOver(false);
    if (!e.dataTransfer) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0) {
      e.preventDefault();
      const fd = new FormData();
      for (const f of files) fd.append("files", f, f.name);
      try {
        const r = await fetch(`/${chPath(channel)}/upload`, { method: "POST", body: fd });
        const data = (await r.json()) as { paths?: string[] };
        if (data.paths?.length) insertFormatted(data.paths);
      } catch {}
      return;
    }
    // No File objects (e.g. dragging text/url); try uri-list or plain path.
    const paths: string[] = [];
    const uri = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/x-moz-url") || "";
    for (const line of uri.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      if (s.startsWith("file://")) {
        try { paths.push(decodeURIComponent(new URL(s).pathname)); } catch {}
      } else paths.push(s);
    }
    if (!paths.length) {
      const plain = e.dataTransfer.getData("text/plain");
      if (plain && (plain.startsWith("/") || plain.startsWith("~") || /^[A-Za-z]:[\\/]/.test(plain))) {
        paths.push(plain.trim());
      }
    }
    if (!paths.length) return;
    e.preventDefault();
    insertFormatted(paths);
  };

  return (
    <form
      className={`composer${dragOver ? " drag-over" : ""}`}
      autoComplete="off"
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      onDragEnter={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.length) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDragOver(false);
      }}
      onDrop={onDrop as any}
    >
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        placeholder="write…"
      />
      {isMobile && (
        <button type="submit" className="composer-send" aria-label="send" disabled={!value.trim()}>
          send
        </button>
      )}
    </form>
  );
}

function ChannelsDropdown({
  channels,
  current,
  anchor,
  onClose,
}: {
  channels: { name: string; count: number }[];
  current: string;
  anchor: HTMLElement | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (anchor && anchor.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose, anchor]);
  const [namespaces, setNamespaces] = useState<{ prefix: string; label: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch("/namespaces").then((r) => r.json()).then((d) => {
      if (!cancelled && Array.isArray(d)) setNamespaces(d);
    }).catch(() => {});
    const es = new EventSource("/namespaces/stream");
    es.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === "namespaces" && Array.isArray(m.namespaces)) setNamespaces(m.namespaces);
      } catch {}
    };
    return () => { cancelled = true; es.close(); };
  }, []);
  const newChannel = (prefix?: string) => {
    const slug = Math.random().toString(36).slice(2, 8);
    window.location.href = "/" + (prefix ? `${encodeURIComponent(prefix)}/${slug}` : slug);
  };
  return (
    <div className="dropdown" ref={ref}>
      <div className="sheet-title">channels</div>
      <nav className="channels">
        {namespaces.length === 0 ? (
          <a href="#" className="new-channel" onClick={(e) => { e.preventDefault(); newChannel(); }}>
            <span>+ new random channel</span>
          </a>
        ) : (
          <>
            <a href="#" className="new-channel" onClick={(e) => { e.preventDefault(); newChannel(); }}>
              <span>+ new (none)</span>
            </a>
            {namespaces.map((n) => (
              <a key={n.prefix} href="#" className="new-channel" onClick={(e) => { e.preventDefault(); newChannel(n.prefix); }}>
                <span>+ new {n.label}</span>
              </a>
            ))}
          </>
        )}
        {channels.map((c) => (
          <a key={c.name} href={`/${chPath(c.name)}`} className={c.name === current ? "active" : ""}>
            <span>{c.name}</span>
            <span className="count">{c.count}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}

function Overlay({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className={`overlay${open ? " open" : ""}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="sheet" role="dialog" aria-label="settings">
        {children}
      </div>
    </div>
  );
}
