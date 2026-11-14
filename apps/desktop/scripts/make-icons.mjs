// Renders the app and tray icons from SVG with Playwright's Chromium:
//   node apps/desktop/scripts/make-icons.mjs
// Output goes to apps/desktop/assets (committed, so builds don't need a browser).
// Needs Playwright installed where this runs (not a project dependency).
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
mkdirSync(out, { recursive: true });

// Three rising bars on a dark tile: a stats lab, not anyone's logo.
const bars = (s) => `
  <rect x="${s * 0.0}" y="0" width="${s}" height="${s}" rx="${s * 0.22}" fill="#14213d"/>
  <rect x="${s * 0.2}" y="${s * 0.56}" width="${s * 0.16}" height="${s * 0.24}" rx="${s * 0.03}" fill="#5fa8ff"/>
  <rect x="${s * 0.42}" y="${s * 0.38}" width="${s * 0.16}" height="${s * 0.42}" rx="${s * 0.03}" fill="#5fa8ff"/>
  <rect x="${s * 0.64}" y="${s * 0.2}" width="${s * 0.16}" height="${s * 0.6}" rx="${s * 0.03}" fill="#ff9f43"/>`;

const dot = (s, color) =>
  color ? `<circle cx="${s * 0.78}" cy="${s * 0.78}" r="${s * 0.2}" fill="${color}" stroke="#ffffff" stroke-width="${s * 0.06}"/>` : "";

const svg = (s, color) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">${bars(s)}${dot(s, color)}</svg>`;

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
