import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const daemon = "127.0.0.1:7777";

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: { proxy: { "/ws": { target: `ws://${daemon}`, ws: true } } },
});
