// Minimal JSONL client for `codex app-server`.
//
// Spawns one persistent app-server child process and exposes:
//  - request(method, params) → Promise<result>
//  - notify(method, params)
//  - onNotification(handler)
//  - onServerRequest(handler) — must call request.respond({...})

import { spawn, type ChildProcess } from "node:child_process";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export type IncomingServerRequest = {
  id: number | string;
  method: string;
  params: any;
  respond: (result: any) => void;
  error: (code: number, message: string) => void;
};

export type Notification = { method: string; params: any };

export class AppServerClient {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private notifHandlers: Array<(n: Notification) => void> = [];
  private requestHandlers: Array<(r: IncomingServerRequest) => void> = [];
  private buf = "";

  constructor(opts: { codexBin?: string; cwd?: string } = {}) {
    const bin = opts.codexBin ?? "codex";
    this.proc = spawn(bin, ["app-server"], {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => this.onData(chunk));
    this.proc.on("exit", (code) => {
      const err = new Error(`codex app-server exited (code=${code})`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: any) {
    if ("result" in msg && "id" in msg) {
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); p.resolve(msg.result); }
      return;
    }
    if ("error" in msg && "id" in msg) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      }
      return;
    }
    if (typeof msg.method === "string" && "id" in msg) {
      // server-initiated request — needs a response
      const id = msg.id;
      const req: IncomingServerRequest = {
        id, method: msg.method, params: msg.params,
        respond: (result) => this.write({ id, result }),
        error: (code, message) => this.write({ id, error: { code, message } }),
      };
      for (const h of this.requestHandlers) {
        try { h(req); } catch (e) { console.error("server-request handler error:", e); }
      }
      return;
    }
    if (typeof msg.method === "string") {
      const n: Notification = { method: msg.method, params: msg.params };
      for (const h of this.notifHandlers) {
        try { h(n); } catch (e) { console.error("notification handler error:", e); }
      }
    }
  }

  private write(obj: any) {
    this.proc.stdin!.write(JSON.stringify(obj) + "\n");
  }

  request<T = any>(method: string, params: any): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: any) {
    this.write(params === undefined ? { method } : { method, params });
  }

  onNotification(h: (n: Notification) => void) { this.notifHandlers.push(h); }
  onServerRequest(h: (r: IncomingServerRequest) => void) { this.requestHandlers.push(h); }

  async initialize(clientInfo: { name: string; title: string; version: string }) {
    await this.request("initialize", { clientInfo, capabilities: null });
    this.notify("initialized");
  }

  kill() {
    try { this.proc.kill(); } catch {}
  }
}
