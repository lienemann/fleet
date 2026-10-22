import { defineConfig, devices } from "@playwright/test";

// Each browser gets its own demo daemon, so their runs cannot see each other's tasks.
const browsers = [
  { name: "chromium", device: devices["Desktop Chrome"], port: 7791 },
  { name: "firefox", device: devices["Desktop Firefox"], port: 7792 },
  { name: "webkit", device: devices["Desktop Safari"], port: 7793 },
];

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: { trace: "retain-on-failure" },
  projects: browsers.map(({ name, device, port }) => ({
    name,
    use: { ...device, baseURL: `http://127.0.0.1:${port}` },
  })),
  webServer: browsers.map(({ port }, i) => ({
    // Build once; the other servers start from the same bundle.
    command: i === 0 ? "npm run build:web && node e2e/serve.ts" : "node e2e/serve.ts",
    url: `http://127.0.0.1:${port}`,
    env: { PORT: String(port) },
    reuseExistingServer: false,
  })),
});
