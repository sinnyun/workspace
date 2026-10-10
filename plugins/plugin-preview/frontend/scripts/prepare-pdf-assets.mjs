// Copy the pdf.js runtime assets the viewer needs *locally* into `dist/`.
//
// Why this exists: `pdfPlugin()` without options resolves the worker, the CJK
// cmaps and the standard fonts from jsDelivr. This app previews local files and
// must keep working with the network down, so those three go next to the plugin
// bundle and the plugin points at them with URLs relative to its own module.
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const frontend = resolve(here, "..");
const dist = resolve(frontend, "dist");
const require = createRequire(resolve(frontend, "noop.js"));
const pdfjs = resolve(require.resolve("pdfjs-dist/package.json"), "..");

const files = [
  ["build/pdf.worker.min.mjs", "pdf.worker.min.mjs"],
];
const dirs = [["cmaps", "pdfcmaps"], ["standard_fonts", "pdffonts"]];

function missing(what) {
  console.error(`prepare-pdf-assets: ${what} not found under ${pdfjs}`);
  process.exit(1);
}

if (!existsSync(dist)) missing("dist (run vite build first)");
for (const [from, to] of files) {
  const src = resolve(pdfjs, from);
  if (!existsSync(src)) missing(from);
  cpSync(src, resolve(dist, to));
}
for (const [from, to] of dirs) {
  const src = resolve(pdfjs, from);
  if (!existsSync(src)) missing(from);
  const out = resolve(dist, to);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(src, out, { recursive: true });
}

const kb = (p) => Math.round(statSync(p).size / 1024);
console.log(
  `pdf assets copied to dist: worker ${kb(resolve(dist, "pdf.worker.min.mjs"))} KB,` +
    ` ${dirs[0][1]}/, ${dirs[1][1]}/ (lazy — nothing here is fetched unless a PDF is previewed)`,
);
