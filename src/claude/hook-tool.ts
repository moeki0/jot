import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { append, gate, signal } from "./jot-client";
import { resolveChannel } from "./channel";
import { readJsonStdin, writeStdout } from "./io";

const DEFAULT_ALLOW = new Set([
  "TodoWrite", "Task", "Skill", "ExitPlanMode",
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "TaskStop",
  "ScheduleWakeup", "ToolSearch",
]);

const DIFF_LANG: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  py: "python", rb: "ruby", go: "go", rs: "rust", swift: "swift",
  sh: "bash", bash: "bash", zsh: "bash",
  json: "json", yaml: "yaml", yml: "yaml", toml: "ini",
  md: "markdown", markdown: "markdown",
  html: "xml", htm: "xml",
  css: "css", scss: "scss", sass: "scss", sql: "sql",
};

function shortpath(p: string): string {
  const h = homedir();
  return p.startsWith(h + "/") ? "~/" + p.slice(h.length + 1) : p;
}

function readJsonFile(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function collectAllowEntries(cwd: string): string[] {
  const files = [
    `${homedir()}/.claude/settings.json`,
    `${homedir()}/.claude/settings.local.json`,
    `${cwd}/.claude/settings.json`,
    `${cwd}/.claude/settings.local.json`,
  ];
  const entries: string[] = [];
  for (const f of files) {
    const j = readJsonFile(f);
    const list = j?.permissions?.allow;
    if (Array.isArray(list)) entries.push(...list.filter((x: any) => typeof x === "string"));
  }
  return entries;
}

function matchesEntry(entry: string, tool: string, bashCmd: string, skillName: string): boolean {
  if (entry === tool) return true;
  const paren = entry.match(new RegExp(`^${tool}\\((.*)\\)$`));
  if (paren) {
    const pat = paren[1]!;
    if (tool === "Bash") {
      if (pat === "*") return true;
      if (pat.endsWith(":*")) return bashCmd.startsWith(pat.slice(0, -2));
      return pat === bashCmd;
    }
    if (tool === "Skill") return pat === "*" || pat === skillName;
    return pat === "*";
  }
  if (entry.endsWith("*")) {
    return tool.startsWith(entry.slice(0, -1));
  }
  return false;
}

async function unifiedDiff(oldText: string, newText: string): Promise<string> {
  const tmpA = `/tmp/jot-diff-a-${process.pid}-${Date.now()}`;
  const tmpB = `/tmp/jot-diff-b-${process.pid}-${Date.now()}`;
  await Bun.write(tmpA, oldText);
  await Bun.write(tmpB, newText);
  const proc = Bun.spawn(["diff", "-u", tmpA, tmpB], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  try { await Bun.file(tmpA).delete?.(); } catch {}
  try { await Bun.file(tmpB).delete?.(); } catch {}
  // Drop the first 2 header lines (--- / +++) to match the bash version.
  const lines = out.split("\n");
  const body = lines.slice(2).join("\n").replace(/\n$/, "");
  return body;
}

function buildMarkdown(input: any, tool: string, bashCmd: string): Promise<string> | string {
  switch (tool) {
    case "Edit": {
      const fp = shortpath(input.tool_input?.file_path ?? "");
      const oldS = input.tool_input?.old_string ?? "";
      const newS = input.tool_input?.new_string ?? "";
      const ext = fp.split(".").pop() ?? "";
      const lang = DIFF_LANG[ext];
      const difflang = lang ? `diff:${lang}` : "diff";
      return (async () => {
        const body = await unifiedDiff(oldS, newS);
        return `> **Edit** \`${fp}\`\n\n\`\`\`${difflang}\n${body}\n\`\`\``;
      })();
    }
    case "Write":
      return `> **Write** \`${shortpath(input.tool_input?.file_path ?? "")}\``;
    case "Bash":
      return `> **Bash**\n\n\`\`\`bash\n${bashCmd}\n\`\`\``;
    case "Read":
      return `> **Read** \`${shortpath(input.tool_input?.file_path ?? "")}\``;
    case "Glob":
      return `> **Glob** \`${input.tool_input?.pattern ?? ""}\``;
    case "Grep":
      return `> **Grep** \`${input.tool_input?.pattern ?? ""}\``;
    case "WebFetch":
      return `> **WebFetch** \`${input.tool_input?.url ?? ""}\``;
    case "WebSearch":
      return `> **WebSearch** \`${input.tool_input?.query ?? ""}\``;
    default: {
      const args = input.tool_input;
      if (!args || (typeof args === "object" && Object.keys(args).length === 0)) {
        return `> **${tool}**`;
      }
      return `> **${tool}**\n\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\``;
    }
  }
}

function persistAllow(tool: string, bashCmd: string, skillName: string) {
  let pattern = tool;
  if (tool === "Bash") {
    const first = bashCmd.trim().split(/\s+/)[0] ?? "";
    pattern = first ? `Bash(${first}:*)` : "Bash(*)";
  } else if (tool === "Skill") {
    pattern = skillName ? `Skill(${skillName})` : "Skill";
  }
  const file = `${homedir()}/.claude/settings.local.json`;
  const j = readJsonFile(file);
  if (!j) return;
  const cur: string[] = j.permissions?.allow ?? [];
  if (cur.includes(pattern)) return;
  j.permissions = j.permissions ?? {};
  j.permissions.allow = [...new Set([...cur, pattern])];
  try { writeFileSync(file, JSON.stringify(j, null, 2)); } catch {}
}

export async function hookTool() {
  const input = await readJsonStdin<any>();
  const tool: string = input.tool_name ?? "";
  if (!tool) return;
  const sessionId: string = input.session_id ?? "";
  const cwd: string = input.cwd ?? "";

  const bashCmd: string = tool === "Bash" ? (input.tool_input?.command ?? "") : "";
  const skillName: string = tool === "Skill"
    ? (input.tool_input?.skill ?? input.tool_input?.skill_name ?? "")
    : "";

  // Allowlist?
  let allowlisted = DEFAULT_ALLOW.has(tool);
  if (!allowlisted) {
    for (const entry of collectAllowEntries(cwd)) {
      if (matchesEntry(entry, tool, bashCmd, skillName)) { allowlisted = true; break; }
    }
  }

  let md = await Promise.resolve(buildMarkdown(input, tool, bashCmd));
  if (md.length > 4000) md = md.slice(0, 3997) + "…";

  const channel = resolveChannel(sessionId);

  if (allowlisted || !sessionId) {
    await append(channel, md);
    writeStdout(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    }));
    return;
  }

  const timeoutMs = Number(process.env.JOT_PERM_TIMEOUT ?? 600000);
  const key = ("cc:" + sessionId).replace(/[^A-Za-z0-9:_.-]/g, "_");

  // Self-signal so the gate enters awaiting state.
  setTimeout(() => { void signal(channel, key); }, 200);

  const resp = await gate(channel, key, md, [
    { label: "Allow", value: "allow", color: "oklch(45% 0.15 145)" },
    { label: "Allow always", value: "allow", remember: true, color: "oklch(45% 0.15 145)" },
    { label: "Deny", value: "deny", color: "oklch(55% 0.20 25)" },
  ], timeoutMs);

  const value = resp.value ?? "deny";
  if (value === "allow" && resp.remember) {
    persistAllow(tool, bashCmd, skillName);
  }

  if (value === "allow") {
    writeStdout(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    }));
  } else {
    writeStdout(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: resp.message || "denied via jot",
      },
    }));
  }
}
