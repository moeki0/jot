import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";

const SESSIONS_FILE = process.env.JOT_SESSIONS_FILE ?? `${homedir()}/.config/jot/sessions.json`;
const DEFAULT_CHANNEL = process.env.JOT_DEFAULT_CHANNEL ?? "claude-code";
const SESSION_PREFIX = process.env.JOT_SESSION_PREFIX ?? "cc";

function readMap(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(SESSIONS_FILE, "utf8")) ?? {};
  } catch { return {}; }
}

function writeMap(map: Record<string, string>) {
  try {
    mkdirSync(dirname(SESSIONS_FILE), { recursive: true });
    writeFileSync(SESSIONS_FILE, JSON.stringify(map));
  } catch {}
}

function slugify(prompt: string): string {
  const head = prompt.slice(0, 200).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!head) return "";
  const slug = head.split(/\s+/).slice(0, 3).join("-").slice(0, 32).replace(/-$/, "");
  return slug;
}

export function resolveChannel(sessionId: string | undefined, prompt?: string): string {
  if (process.env.JOT_CHANNEL) return process.env.JOT_CHANNEL;
  if (!sessionId) return DEFAULT_CHANNEL;

  const map = readMap();
  const existing = map[sessionId];

  let fromPrompt = "";
  if (prompt) {
    const matches = [...prompt.matchAll(/<jot-route channel="([^"]+)"/g)];
    if (matches.length) fromPrompt = matches[matches.length - 1]![1] ?? "";
  }

  if (fromPrompt && fromPrompt !== existing) {
    map[sessionId] = fromPrompt;
    writeMap(map);
    return fromPrompt;
  }
  if (existing) return existing;

  const slug = prompt ? slugify(prompt) : "";
  const sidShort = sessionId.slice(0, 6);
  const channel = slug ? `${slug}-${sidShort}` : `${SESSION_PREFIX}-${sidShort}`;

  if (prompt) {
    map[sessionId] = channel;
    writeMap(map);
  }
  return channel;
}
