import { defineConfig, devices } from "@playwright/test";

// Each browser gets its own demo daemon, so their runs cannot see each other's tasks.
// FLEET_E2E_PORT moves them all, for running two suites side by side.
const base = Number(process.env.FLEET_E2E_PORT ?? 7791);
const browsers = [
  { name: "chromium", device: devices["Desktop Chrome"], port: base },
  { name: "firefox", device: devices["Desktop Firefox"], port: base + 1 },
  { name: "webkit", device: devices["Desktop Safari"], port: base + 2 },
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
