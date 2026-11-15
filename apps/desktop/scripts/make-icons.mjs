// Renders the app icons from assets/icon.svg and the tray icons from assets/icon-small.svg (the
// Miss marker: a ball, a target ring and an orange dot just outside it; the small one has a solid,
// thicker ring and a bigger dot, no connector, so it holds up at 16 px) with Playwright's Chromium:
//   node apps/desktop/scripts/make-icons.mjs
// Output goes to apps/desktop/assets (committed, so builds don't need a browser).
// Needs Playwright installed where this runs (not a project dependency).
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const innerOf = (file) =>
  readFileSync(join(out, file), "utf8").replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/<title>.*?<\/title>/, "");
const inner = innerOf("icon.svg");
const innerSmall = innerOf("icon-small.svg");

// The tray icon is the small-size app icon, no status dot (Joe: it read as two balls). Paused: grayed
// out. Update ready: an orange badge with two curved arrows, like Windows Update's.
const arrows = (cx, cy, r) => {
  // Two arcs around the badge's center, each ending in an arrowhead, chasing each other.
  const pt = (deg, rad = r) => [cx + rad * Math.cos((deg * Math.PI) / 180), cy + rad * Math.sin((deg * Math.PI) / 180)];
  const arc = (from, to) => {
    const [x1, y1] = pt(from);
    const [x2, y2] = pt(to);
    return `M${x1} ${y1} A${r} ${r} 0 0 1 ${x2} ${y2}`;
  };
  const head = (deg) => {
    // A triangle at the end of an arc (clockwise), pointing along it.
    const [tx, ty] = pt(deg + 28);
    const [ox, oy] = pt(deg - 4, r + r * 0.55);
    const [ix, iy] = pt(deg - 4, r - r * 0.55);
    return `M${ox} ${oy} L${tx} ${ty} L${ix} ${iy} Z`;
  };
  const w = r * 0.42;
  return `<g fill="none" stroke="#fff" stroke-width="${w}" stroke-linecap="round">
      <path d="${arc(200, 330)}"/><path d="${arc(20, 150)}"/></g>
    <g fill="#fff"><path d="${head(330)}"/><path d="${head(150)}"/></g>`;
};
const badge = `<circle cx="744" cy="744" r="248" fill="#f7630c" stroke="#ffffff" stroke-width="56"/>${arrows(744, 744, 122)}`;

const svg = (s, { paused = false, update = false, tray = false } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 1024 1024">
    <g ${paused ? 'style="filter: grayscale(1)"' : ""}>${tray ? innerSmall : inner}</g>${update ? badge : ""}</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage();
async function render(file, size, opts) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(size, opts)}</body></html>`);
  const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  writeFileSync(join(out, file), png);
}

await render("icon.png", 256);
await render("icon-512.png", 512);
for (const [name, opts] of [
  ["tray", {}],
  ["tray-paused", { paused: true }],
  ["tray-update", { update: true }],
  ["tray-paused-update", { paused: true, update: true }],
]) {
  await render(`${name}.png`, 16, { ...opts, tray: true });
  await render(`${name}@2x.png`, 32, { ...opts, tray: true });
}
// A larger one to look at: node scripts/make-icons.mjs --preview
if (process.argv.includes("--preview")) await render("update-preview.png", 256, { update: true, tray: true });
await browser.close();
console.log(`icons written to ${out}`);
