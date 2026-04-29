export const JOT_URL = process.env.JOT_URL ?? "http://localhost:7878";

async function safe(promise: Promise<any>) {
  try { await promise; } catch {}
}

export async function postRaw(path: string, body?: string, opts?: { headers?: Record<string,string>, timeoutMs?: number }) {
  await safe(fetch(`${JOT_URL}${path}`, {
    method: "POST",
    body: body ?? "",
    headers: opts?.headers,
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 2000),
  }));
}

export async function append(channel: string, body: string) {
  await postRaw(`/${channel}/append?internal=1`, body, { timeoutMs: 1500 });
}

export async function ephemeral(channel: string, body: string, key?: string) {
  const q = key ? `?key=${encodeURIComponent(key)}` : "";
  await postRaw(`/${channel}/ephemeral${q}`, body, { timeoutMs: 1500 });
}

export async function signal(channel: string, key: string, body = "") {
  try {
    const res = await fetch(`${JOT_URL}/${channel}/signal?key=${encodeURIComponent(key)}`, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(2500),
    });
    return await res.json().catch(() => ({})) as any;
  } catch { return {}; }
}

export type GateAction = { label: string; value: string; color?: string; remember?: boolean };

export async function gate(channel: string, key: string, markdown: string, actions: GateAction[], timeoutMs: number) {
  try {
    const res = await fetch(
      `${JOT_URL}/${channel}/gate?key=${encodeURIComponent(key)}&wait=2000&timeout=${timeoutMs}&auto=deny`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markdown, actions }),
        signal: AbortSignal.timeout(timeoutMs + 5000),
      }
    );
    return await res.json() as { value?: string; message?: string; remember?: boolean };
  } catch {
    return { value: "deny" };
  }
}
