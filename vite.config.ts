import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const daemon = "127.0.0.1:7777";

// One number per build. The page carries it, and version.json next to the files tells the
// daemon, so a page from an older build can notice and reload.
const build = Date.now();

const versionFile: Plugin = {
  name: "fleet-version",
  apply: "build",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build }) });
  },
};

export default defineConfig({
  root: "src/web",
  plugins: [react(), versionFile],
  define: { __FLEET_BUILD__: JSON.stringify(build) },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    // One bundle, loaded once from the local daemon; splitting it would not make that faster.
    chunkSizeWarningLimit: 1024,
  },
  server: {
    proxy: {
      "/ws": {
        target: `ws://${daemon}`,
        ws: true,
        // The daemon only accepts its own origin; the dev server stands in for it.
        configure: (proxy) => {
          proxy.on("proxyReqWs", (req) => req.setHeader("origin", `http://${daemon}`));
        },
        changeOrigin: true,
      },
    },
  },
});
