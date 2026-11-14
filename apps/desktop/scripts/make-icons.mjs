// Renders the app and tray icons from assets/icon.svg (Joe's Whiff icon) with Playwright's Chromium:
//   node apps/desktop/scripts/make-icons.mjs
// Output goes to apps/desktop/assets (committed, so builds don't need a browser).
// Needs Playwright installed where this runs (not a project dependency).
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const source = readFileSync(join(out, "icon.svg"), "utf8");
const inner = source.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/<title>.*?<\/title>/, "");

// The tray's state as a dot in the bottom-right corner, over the trail.
const dot = (color) =>
  color ? `<circle cx="790" cy="790" r="220" fill="${color}" stroke="#ffffff" stroke-width="64"/>` : "";

const svg = (s, color) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 1024 1024">${inner}${dot(color)}</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage();
async function render(file, size, color) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(size, color)}</body></html>`);
  const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  writeFileSync(join(out, file), png);
}

await render("icon.png", 256);
await render("icon-512.png", 512);
const states = { connected: "#2ecc71", waiting: "#9aa5b1", paused: "#f5b041" };
for (const [state, color] of Object.entries(states)) {
  await render(`tray-${state}.png`, 16, color);
  await render(`tray-${state}@2x.png`, 32, color);
}
await browser.close();
console.log(`icons written to ${out}`);
