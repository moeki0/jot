import { marked } from "/marked.js";
import hljs from "/hljs.js";

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

marked.use({
  renderer: {
    code({ text, lang }) {
      if (lang === "diff") {
        const raw = text.replace(/\n+$/, "");
        const lines = raw.split("\n").map((line) => {
          const cls = line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del" : line.startsWith("@") ? "diff-hunk" : "";
          return cls
            ? `<span class="${cls}">${escapeHtml(line) || " "}</span>`
            : `<span>${escapeHtml(line) || " "}</span>`;
        });
        return `<pre class="diff"><code>${lines.join("")}</code></pre>`;
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

const channel = decodeURIComponent(location.pathname.replace(/^\//, "")) || "default";
if (location.pathname === "/") {
  history.replaceState(null, "", "/" + channel);
}

const stream = document.getElementById("stream");
const dot = document.getElementById("dot");
const channelName = document.getElementById("channel-name");
const channelsNav = document.getElementById("channels");
channelName.textContent = channel;

const seen = new Set();
let empty = true;
const unread = new Set();
const fragmentEls = new Map(); // id -> element
let status = null;

const visibilityObserver = new IntersectionObserver(
  (entries) => {
    let changed = false;
    for (const e of entries) {
      if (e.isIntersecting) {
        const id = Number(e.target.dataset.id);
        if (unread.has(id)) {
          unread.delete(id);
          changed = true;
        }
        visibilityObserver.unobserve(e.target);
      }
    }
    if (changed) updateBar();
  },
  { threshold: 0, rootMargin: "0px 0px -50px 0px" },
);

function fmtTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function isInitialBacklog() {
  // first batch of fragments that arrive at startup are not "new"
  return !document.body.classList.contains("ready");
}

function render(f) {
  if (seen.has(f.id)) return;
  seen.add(f.id);
  if (empty) {
    stream.innerHTML = "";
    empty = false;
  }
  const div = document.createElement("article");
  div.className = "fragment";
  div.dataset.id = String(f.id);
  const ts = document.createElement("div");
  ts.className = "ts";
  ts.textContent = fmtTime(f.ts);
  const body = document.createElement("div");
  body.className = "body";
  body.innerHTML = marked.parse(f.markdown);
  div.appendChild(ts);
  div.appendChild(body);
  stream.appendChild(div);
  fragmentEls.set(f.id, div);
  if (!isInitialBacklog()) {
    unread.add(f.id);
    visibilityObserver.observe(div);
    updateBar();
  }
}

function showEmpty() {
  stream.innerHTML = `
    <div class="empty">
      <div>nothing yet on <strong>${channel}</strong></div>
      <code>echo "## hello" | curl -s --data-binary @- localhost:${location.port}/${channel}/append</code>
    </div>
  `;
}

async function loadChannels() {
  try {
    const r = await fetch("/channels");
    const list = await r.json();
    if (list.length === 0) return;
    channelsNav.innerHTML = list
      .map(
        (c) =>
          `<a href="/${encodeURIComponent(c.name)}" class="${c.name === channel ? "active" : ""}"><span>${c.name}</span><span class="count">${c.count}</span></a>`,
      )
      .join("");
  } catch {}
}

// status bar at bottom
const bar = document.createElement("button");
bar.className = "status-bar";
bar.type = "button";
bar.addEventListener("click", () => {
  // scroll to oldest unread fragment, not the bottom
  const oldestUnread = [...unread].sort((a, b) => a - b)[0];
  const el = oldestUnread != null ? fragmentEls.get(oldestUnread) : null;
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }
});
document.body.appendChild(bar);

function escape(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function updateBar() {
  const parts = [];
  if (status) parts.push(`<span class="bar-dot"></span> ${escape(status)}`);
  if (unread.size > 0) parts.push(`↓ ${unread.size} new`);
  if (parts.length === 0) {
    bar.classList.remove("show");
    bar.innerHTML = "";
    return;
  }
  bar.innerHTML = parts.join(" · ");
  bar.classList.add("show");
}

function connect() {
  const es = new EventSource(`/${encodeURIComponent(channel)}/stream`);
  let backlogTimer = null;
  es.onopen = () => {
    dot.classList.add("live");
    // mark backlog as done after 250ms of silence
    backlogTimer = setTimeout(() => {
      document.body.classList.add("ready");
    }, 250);
  };
  es.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.type === "fragment") {
        render(ev.fragment);
      } else if (ev.type === "status") {
        status = ev.status ?? null;
        updateBar();
      }
      // bump backlog timer — keep extending while messages flood in
      if (backlogTimer) {
        clearTimeout(backlogTimer);
        backlogTimer = setTimeout(() => {
          document.body.classList.add("ready");
        }, 250);
      }
    } catch {}
  };
  es.onerror = () => {
    dot.classList.remove("live");
    setTimeout(connect, 1500);
  };
}

// channel overlay
const overlay = document.getElementById("overlay");
const channelButton = document.getElementById("channel-button");

function openOverlay() {
  loadChannels();
  overlay.classList.add("open");
}
function closeOverlay() {
  overlay.classList.remove("open");
}
function isOpen() {
  return overlay.classList.contains("open");
}
channelButton.addEventListener("click", openOverlay);
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) closeOverlay();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeOverlay();
  if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    isOpen() ? closeOverlay() : openOverlay();
  }
});

showEmpty();
connect();

// dev auto-reload — disabled (was causing reconnect loops)
// const dev = new EventSource("/_dev");
// dev.onmessage = (e) => {
//   if (e.data === "reload") location.reload();
// };
