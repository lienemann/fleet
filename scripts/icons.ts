// Renders the app icons from src/web/public/icon.svg; run after changing the SVG.
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const svg = readFileSync(new URL("../src/web/public/icon.svg", import.meta.url), "utf8");
const browser = await chromium.launch();
const page = await browser.newPage();

for (const [size, name, padding] of [
  [192, "icon-192.png", 0],
  [512, "icon-512.png", 0],
  // Maskable icons must keep their content inside the central 80 %.
  [512, "icon-maskable.png", 52],
  [180, "apple-touch-icon.png", 0],
] as const) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0;background:${padding ? "#8b1e2d" : "transparent"}"><div style="padding:${padding}px">${svg.replace("<svg ", `<svg width="${size - 2 * padding}" height="${size - 2 * padding}" `)}</div></body>`,
  );
  await page.screenshot({
    path: new URL(`../src/web/public/${name}`, import.meta.url).pathname,
    omitBackground: padding === 0,
  });
}
await browser.close();
