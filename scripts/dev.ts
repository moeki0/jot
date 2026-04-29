import { spawn } from "bun";

const procs = [
  spawn({ cmd: ["bun", "--hot", "src/cli.ts"], stdout: "inherit", stderr: "inherit", stdin: "inherit" }),
  spawn({ cmd: ["bunx", "vite"], stdout: "inherit", stderr: "inherit", stdin: "inherit" }),
];

const shutdown = () => {
  for (const p of procs) { try { p.kill(); } catch {} }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", shutdown);

await Promise.race(procs.map((p) => p.exited));
shutdown();
