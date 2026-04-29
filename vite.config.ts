import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_TARGET = "http://localhost:7878";

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: "public",
    emptyOutDir: false,
    rollupOptions: {
      output: {
        entryFileNames: "app.js",
        assetFileNames: "[name][extname]",
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/channels": { target: API_TARGET, changeOrigin: true },
      // Forward channel-scoped API endpoints to the Bun server.
      "^/[^/]+/(stream|append|decide|permission|gate|signal|status|wait)(/.*)?$": {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
});
