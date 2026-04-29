// Bundles a tiny highlight.js (core + bash) ESM bundle into public/hljs.js
import { build } from "bun";

const entry = "/tmp/stream-md-hljs-entry.ts";
await Bun.write(
  entry,
  `
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
hljs.registerLanguage("bash", bash);
export default hljs;
`,
);

await build({
  entrypoints: [entry],
  outdir: "/Users/moeki/stream.md/public",
  naming: "hljs.js",
  minify: true,
  format: "esm",
});

console.log("hljs.js built");
