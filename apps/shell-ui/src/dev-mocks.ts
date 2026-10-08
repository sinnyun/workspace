/**
 * Browser-dev mocks. When the shell runs under plain `vite dev` (no Tauri),
 * capability invokes would otherwise reject. These mocks let the UI and plugin
 * loading be exercised headless. Inside Tauri the real commands win
 * (invokeCapability tries Tauri first and only falls back to a mock on throw).
 *
 * The stress dataset here is deliberately **realistic** — per-format size
 * distributions (KB screenshots up to 8 GB images), believable names, mtimes
 * spread over two years, and real generated thumbnails for images — and it is
 * served through the same `fs.list` path the file browser uses, so the center
 * grid and its virtualization are what actually render it (docs/02 §4).
 */
import { registerMock } from "./invoke";
import type { ListEntry, PluginManifest, StatOut, ThumbOut } from "@my-file-manager/plugin-sdk";

import fileHistoryManifest from "../../../plugins/plugin-file-history/manifest.json";
import devtoolsLogManifest from "../../../plugins/plugin-devtools-log/manifest.json";
import fileDetailsManifest from "../../../plugins/plugin-file-details/manifest.json";
import layoutPanesManifest from "../../../plugins/plugin-layout-panes/manifest.json";
import layoutViewsManifest from "../../../plugins/plugin-layout-views/manifest.json";
import inspectorManifest from "../../../plugins/plugin-inspector/manifest.json";
import fileBrowserManifest from "../../../plugins/plugin-file-browser/manifest.json";
import viewFileTreeManifest from "../../../plugins/plugin-view-file-tree/manifest.json";
import viewFavoritesManifest from "../../../plugins/plugin-view-favorites/manifest.json";
import viewTagsManifest from "../../../plugins/plugin-view-tags/manifest.json";
import settingsManifest from "../../../plugins/plugin-settings/manifest.json";
import previewTextManifest from "../../../plugins/plugin-preview-text/manifest.json";
import mockDataManifest from "../../../plugins/plugin-mock-data/manifest.json";
import slotHarnessManifest from "../../../plugins/plugin-dev-slot-harness/manifest.json";

const MIB = 1024 * 1024;
const KIB = 1024;
const GIB = 1024 * MIB;

/** Root of the synthetic dataset. `<ROOT>/<volume>` lists that many entries. */
const STRESS_ROOT = "/stress";

/** One synthetic dataset volume, listed under `<ROOT>` as a directory. */
const VOLUMES = [
  { name: "数据集-1千", count: 1_000 },
  { name: "数据集-1万", count: 10_000 },
  { name: "数据集-10万", count: 100_000 },
  { name: "数据集-50万", count: 500_000 },
];

const fakeTree: Record<string, ListEntry[]> = {
  "/demo": [
    entry("notes.txt", "/demo/notes.txt", false, 1284, daysAgo(12)),
    entry("report.md", "/demo/report.md", false, 5321, daysAgo(3)),
    entry("empty", "/demo/empty", true, null, null),
    entry("broken", "/demo/broken", true, null, null),
    entry("src", "/demo/src", true, null, null),
  ],
  "/demo/empty": [],
  "/demo/src": [
    entry("main.rs", "/demo/src/main.rs", false, 2048, daysAgo(41)),
    entry("lib.rs", "/demo/src/lib.rs", false, 900, daysAgo(40)),
  ],
};

function entry(
  name: string,
  path: string,
  isDir: boolean,
  size: number | null,
  modifiedMs: number | null,
): ListEntry {
  return { name, path, isDir, size, modifiedMs };
}

function daysAgo(days: number): number {
  return Date.now() - days * 86_400_000;
}

// ─────────────────────── realistic dataset generator ───────────────────────

/** What `fs.readText` should do with a file of this shape. */
type ContentKind = "text" | "binary";

interface FormatSpec {
  /** Name prefixes drawn for this format, mixed Chinese + English. */
  stems: string[];
  ext: string;
  group: string;
  min: number;
  max: number;
  /** Relative frequency, in permille-ish weights across the dataset. */
  weight: number;
  content: ContentKind;
  /** `thumb.image` can decode it — false for formats `image` does not support. */
  thumbnail: boolean;
}

const FORMATS: FormatSpec[] = [
  // 图片 — the formats a grid thumbnailer must handle, plus ones it cannot.
  { stems: ["IMG", "DSC", "照片", "截图"], ext: "jpg", group: "图片", min: 300 * KIB, max: 6 * MIB, weight: 60, content: "binary", thumbnail: true },
  { stems: ["screenshot", "图表", "banner", "logo", "PNG导出"], ext: "png", group: "图片", min: 150 * KIB, max: 9 * MIB, weight: 45, content: "binary", thumbnail: true },
  { stems: ["webp", "头图"], ext: "webp", group: "图片", min: 20 * KIB, max: 900 * KIB, weight: 25, content: "binary", thumbnail: true },
  { stems: ["anim", "动图"], ext: "gif", group: "图片", min: 40 * KIB, max: 4 * MIB, weight: 15, content: "binary", thumbnail: true },
  { stems: ["bitmap"], ext: "bmp", group: "图片", min: 1 * MIB, max: 24 * MIB, weight: 8, content: "binary", thumbnail: true },
  { stems: ["扫描底片", "tiff"], ext: "tiff", group: "图片", min: 4 * MIB, max: 60 * MIB, weight: 8, content: "binary", thumbnail: true },
  { stems: ["icon", "插画"], ext: "svg", group: "图片", min: 1 * KIB, max: 180 * KIB, weight: 12, content: "text", thumbnail: false },
  { stems: ["HEIC", "iPhone照片"], ext: "heic", group: "图片", min: 800 * KIB, max: 6 * MIB, weight: 10, content: "binary", thumbnail: false },
  { stems: ["RAW", "CR2底片"], ext: "cr2", group: "图片", min: 18 * MIB, max: 45 * MIB, weight: 6, content: "binary", thumbnail: false },
  // 视频
  { stems: ["VID", "录屏", "camera"], ext: "mp4", group: "视频", min: 4 * MIB, max: 1200 * MIB, weight: 40, content: "binary", thumbnail: false },
  { stems: ["电影", "mkv"], ext: "mkv", group: "视频", min: 20 * MIB, max: 3 * GIB, weight: 20, content: "binary", thumbnail: false },
  { stems: ["mov", "手机视频"], ext: "mov", group: "视频", min: 8 * MIB, max: 800 * MIB, weight: 15, content: "binary", thumbnail: false },
  { stems: ["webm", "直播回放"], ext: "webm", group: "视频", min: 2 * MIB, max: 300 * MIB, weight: 8, content: "binary", thumbnail: false },
  // 音频
  { stems: ["track", "播客"], ext: "mp3", group: "音频", min: 2 * MIB, max: 12 * MIB, weight: 25, content: "binary", thumbnail: false },
  { stems: ["flac", "专辑"], ext: "flac", group: "音频", min: 15 * MIB, max: 60 * MIB, weight: 12, content: "binary", thumbnail: false },
  { stems: ["wav", "录音"], ext: "wav", group: "音频", min: 4 * MIB, max: 90 * MIB, weight: 8, content: "binary", thumbnail: false },
  { stems: ["m4a", "语音备忘"], ext: "m4a", group: "音频", min: 3 * MIB, max: 20 * MIB, weight: 8, content: "binary", thumbnail: false },
  // 文档
  { stems: ["报告", "合同", "invoice", "论文", "手册"], ext: "pdf", group: "文档", min: 20 * KIB, max: 25 * MIB, weight: 70, content: "binary", thumbnail: false },
  { stems: ["方案", "模板"], ext: "docx", group: "文档", min: 15 * KIB, max: 8 * MIB, weight: 45, content: "binary", thumbnail: false },
  { stems: ["数据表", "budget", "对账"], ext: "xlsx", group: "文档", min: 10 * KIB, max: 40 * MIB, weight: 45, content: "binary", thumbnail: false },
  { stems: ["宣讲", "slides"], ext: "pptx", group: "文档", min: 1 * MIB, max: 120 * MIB, weight: 25, content: "binary", thumbnail: false },
  { stems: ["notes", "todo", "日志摘要"], ext: "txt", group: "文档", min: 300, max: 2 * MIB, weight: 40, content: "text", thumbnail: false },
  { stems: ["README", "笔记", "changelog", "设计说明"], ext: "md", group: "文档", min: 400, max: 120 * KIB, weight: 55, content: "text", thumbnail: false },
  { stems: ["export", "订单", "sales"], ext: "csv", group: "文档", min: 2 * KIB, max: 300 * MIB, weight: 30, content: "text", thumbnail: false },
  // 代码 / 配置
  { stems: ["main", "lib", "capability", "kernel", "thumb"], ext: "rs", group: "代码", min: 200, max: 140 * KIB, weight: 25, content: "text", thumbnail: false },
  { stems: ["index", "app", "store"], ext: "ts", group: "代码", min: 200, max: 120 * KIB, weight: 25, content: "text", thumbnail: false },
  { stems: ["Page", "Panel", "Widget"], ext: "tsx", group: "代码", min: 200, max: 90 * KIB, weight: 20, content: "text", thumbnail: false },
  { stems: ["run", "build"], ext: "js", group: "代码", min: 200, max: 200 * KIB, weight: 20, content: "text", thumbnail: false },
  { stems: ["train", "pipeline", "utils"], ext: "py", group: "代码", min: 200, max: 120 * KIB, weight: 25, content: "text", thumbnail: false },
  { stems: ["server", "handler"], ext: "go", group: "代码", min: 200, max: 80 * KIB, weight: 10, content: "text", thumbnail: false },
  { stems: ["package", "config", "dataset", "manifest"], ext: "json", group: "代码", min: 300, max: 30 * MIB, weight: 40, content: "text", thumbnail: false },
  { stems: ["Cargo", "app"], ext: "toml", group: "代码", min: 200, max: 20 * KIB, weight: 15, content: "text", thumbnail: false },
  { stems: ["ci", "compose"], ext: "yaml", group: "代码", min: 200, max: 30 * KIB, weight: 15, content: "text", thumbnail: false },
  { stems: ["styles", "theme"], ext: "css", group: "代码", min: 200, max: 60 * KIB, weight: 15, content: "text", thumbnail: false },
  { stems: ["index", "page"], ext: "html", group: "代码", min: 200, max: 90 * KIB, weight: 15, content: "text", thumbnail: false },
  // 压缩包
  { stems: ["backup", "归档", "release"], ext: "zip", group: "压缩包", min: 100 * KIB, max: 700 * MIB, weight: 45, content: "binary", thumbnail: false },
  { stems: ["archive", "全站备份"], ext: "7z", group: "压缩包", min: 50 * KIB, max: 400 * MIB, weight: 20, content: "binary", thumbnail: false },
  { stems: ["node-modules", "vendor"], ext: "gz", group: "压缩包", min: 10 * KIB, max: 1500 * MIB, weight: 15, content: "binary", thumbnail: false },
  { stems: ["rar", "素材包"], ext: "rar", group: "压缩包", min: 100 * KIB, max: 600 * MIB, weight: 10, content: "binary", thumbnail: false },
  { stems: ["ubuntu", "Win11", "安装盘"], ext: "iso", group: "压缩包", min: 600 * MIB, max: 8 * GIB, weight: 12, content: "binary", thumbnail: false },
  // 数据
  { stems: ["app", "access", "error"], ext: "log", group: "数据", min: 5 * KIB, max: 500 * MIB, weight: 35, content: "text", thumbnail: false },
  { stems: ["production", "analytics", "cordis"], ext: "db", group: "数据", min: 1 * MIB, max: 2 * GIB, weight: 25, content: "binary", thumbnail: false },
  { stems: ["cache", "sessions"], ext: "sqlite", group: "数据", min: 100 * KIB, max: 800 * MIB, weight: 15, content: "binary", thumbnail: false },
  { stems: ["events", "features"], ext: "parquet", group: "数据", min: 5 * MIB, max: 1 * GIB, weight: 12, content: "binary", thumbnail: false },
  { stems: ["blob", "dump"], ext: "bin", group: "数据", min: 1 * KIB, max: 200 * MIB, weight: 15, content: "binary", thumbnail: false },
  // 可执行
  { stems: ["setup", "installer", "安装程序"], ext: "exe", group: "程序", min: 50 * KIB, max: 200 * MIB, weight: 25, content: "binary", thumbnail: false },
  { stems: ["native", "dll"], ext: "dll", group: "程序", min: 20 * KIB, max: 40 * MIB, weight: 15, content: "binary", thumbnail: false },
  { stems: ["msi", "套件"], ext: "msi", group: "程序", min: 1 * MIB, max: 300 * MIB, weight: 12, content: "binary", thumbnail: false },
  { stems: ["app", "apk"], ext: "apk", group: "程序", min: 2 * MIB, max: 150 * MIB, weight: 8, content: "binary", thumbnail: false },
];

/** Directory names, mixed like a real home folder. */
const DIR_STEMS = ["项目", "photos", "备份", "datasets", "docs", "素材", "downloads", "2026-Q3", "archive", "临时"];

/** ~8% of entries are subdirectories, so grouping and drill-in get exercised. */
const DIR_WEIGHT = 95;

const TOTAL_WEIGHT = FORMATS.reduce((sum, f) => sum + f.weight, 0);

/** Cumulative table for the weighted pick, built once. */
const CUMULATIVE: number[] = [];
{
  let acc = 0;
  for (const f of FORMATS) {
    acc += f.weight;
    CUMULATIVE.push(acc);
  }
}

/** mulberry32: small, fast, deterministic — the dataset must be identical on
 *  every reload so repeated stress runs measure the same thing. */
function prng(seed: number): number {
  let a = (seed ^ 0x9e3779b9) >>> 0;
  a = (a + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** The format of entry `i` — derived from `i` alone, so `fs.stat` of a path can
 *  recover it from the name's index without remembering the listing. */
function formatFor(index: number): FormatSpec {
  const pick = prng(index * 2 + 1) * TOTAL_WEIGHT;
  for (let f = 0; f < FORMATS.length; f++) {
    if (pick < CUMULATIVE[f]) return FORMATS[f];
  }
  return FORMATS[FORMATS.length - 1];
}

const isDirectoryIndex = (index: number): boolean => prng(index * 2 + 7) * 1000 < DIR_WEIGHT;

/** Log-uniform size inside the format's range: real directories are dominated by
 *  small files with a long tail, not by a flat average. */
function sizeFor(index: number): number {
  const f = formatFor(index);
  const t = prng(index * 2 + 3);
  return Math.round(f.min * Math.pow(f.max / f.min, t));
}

/** mtime over the last ~2 years, skewed towards recent (power 1.7). */
function modifiedFor(index: number): number {
  const t = Math.pow(prng(index * 2 + 5), 1.7);
  return Date.now() - Math.round(t * 730 * 86_400_000);
}

const INDEX_IN_NAME = /_(\d{6})(\.[^.]*)?$/;

function nameFor(index: number): string {
  const stemIndex = Math.floor(prng(index * 2 + 9) * 100);
  if (isDirectoryIndex(index)) {
    return `${DIR_STEMS[stemIndex % DIR_STEMS.length]}_${String(index).padStart(6, "0")}`;
  }
  const f = formatFor(index);
  return `${f.stems[stemIndex % f.stems.length]}_${String(index).padStart(6, "0")}.${f.ext}`;
}

/** Read a synthetic path back into (index, format) so stat / readText / thumb
 *  agree with the listing that produced it. */
interface Resolved {
  index: number;
  spec: FormatSpec;
  isDir: boolean;
  name: string;
}

function resolveStressPath(path: string): Resolved | null {
  const name = path.split("/").pop() ?? "";
  const m = INDEX_IN_NAME.exec(name);
  if (!m) return null;
  const index = Number(m[1]);
  return { index, spec: formatFor(index), isDir: isDirectoryIndex(index), name };
}

/** The listing of one synthetic directory. A volume lists its full count; a
 *  subdirectory lists a smaller deterministic slice, so drill-in works at depth. */
function stressListing(path: string): ListEntry[] {
  if (path === STRESS_ROOT) return volumeListing();
  const segments = path.slice(STRESS_ROOT.length + 1).split("/");
  // A named volume (`/stress/数据集-10万`) or an explicit count typed into the
  // address bar (`/stress/20000`).
  const head = segments[0] ?? "";
  const count = /^\d+$/.test(head)
    ? Number(head)
    : VOLUMES.find((v) => v.name === head)?.count;
  if (count === undefined) return [];
  if (segments.length === 1) return generateEntries(path, count, 0);
  const childCount = Math.min(60, Math.max(6, Math.round(count / 10 / segments.length)));
  return generateEntries(path, childCount, hashPath(path));
}

function generateEntries(dirPath: string, count: number, seed: number): ListEntry[] {
  const out: ListEntry[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const index = (i + seed) % 1_000_000;
    const name = nameFor(index);
    const isDir = isDirectoryIndex(index);
    out[i] = entry(
      name,
      `${dirPath}/${name}`,
      isDir,
      isDir ? null : sizeFor(index),
      isDir ? null : modifiedFor(index),
    );
  }
  // A real provider hands back a naturally ordered listing (the kernel sorts with
  // natord); names here embed a zero-padded index, so a plain compare matches.
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function hashPath(path: string): number {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 1_000_000;
}

function volumeListing(): ListEntry[] {
  const dirs: ListEntry[] = VOLUMES.map((v) =>
    entry(v.name, `${STRESS_ROOT}/${v.name}`, true, null, null),
  );
  const sample = [
    entry("说明-压力数据.md", `${STRESS_ROOT}/说明-压力数据.md`, false, 4096, daysAgo(1)),
    entry("空目录", `${STRESS_ROOT}/空目录`, true, null, null),
    entry("读取失败", `${STRESS_ROOT}/读取失败`, true, null, null),
  ];
  return [...dirs, ...sample].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const isStressPath = (path: string): boolean => path === STRESS_ROOT || path.startsWith(`${STRESS_ROOT}/`);

// ───────────────────────────── thumbnails ─────────────────────────────

/**
 * A real downscaled PNG, painted on a canvas: gradient background + a coarse
 * noise pattern from the path hash + the file name, then scaled to `edge`.
 * Returning a PNG (not an SVG) matches what the kernel `thumb.image` sends, so
 * the grid renders the same bytes shape in dev and in Tauri.
 */
function syntheticThumb(path: string, edge: number): ThumbOut {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 72;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("dev mock: canvas unavailable");

  const h = hashPath(path);
  const hue = h % 360;
  const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  grad.addColorStop(0, `hsl(${hue} 70% 55%)`);
  grad.addColorStop(1, `hsl(${(hue + 90) % 360} 65% 30%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Deterministic speckle so neighbouring images do not look cloned.
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  for (let i = 0; i < 40; i++) {
    const x = Math.floor(prng(h + i * 13) * canvas.width);
    const y = Math.floor(prng(h + i * 29) * canvas.height);
    ctx.fillRect(x, y, 2, 2);
  }
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(0, canvas.height - 14, canvas.width, 14);
  ctx.fillStyle = "#fff";
  ctx.font = "9px sans-serif";
  ctx.fillText((path.split("/").pop() ?? "").slice(0, 12), 3, canvas.height - 4);

  const out = document.createElement("canvas");
  out.width = edge;
  out.height = Math.max(1, Math.round((edge * canvas.height) / canvas.width));
  const outCtx = out.getContext("2d");
  if (!outCtx) throw new Error("dev mock: canvas unavailable");
  outCtx.imageSmoothingEnabled = true;
  outCtx.drawImage(canvas, 0, 0, out.width, out.height);

  return { dataUrl: out.toDataURL("image/png"), mime: "image/png", edge };
}

// ───────────────────────────── registration ─────────────────────────────

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A dataset directory is any volume path or a synthetic subdirectory below it. */
function isStressDirPath(path: string): boolean {
  if (path === STRESS_ROOT) return true;
  if (!isStressPath(path)) return false;
  const resolved = resolveStressPath(path);
  if (resolved) return resolved.isDir;
  // `/stress/1000` and deeper folders carry no index in the last segment.
  return /^\d+$/.test(path.slice(STRESS_ROOT.length + 1).split("/")[0] ?? "");
}

export function registerMocks(): void {
  // The browser session lands on the dataset root: one click to any volume.
  registerMock("fs.home", () => STRESS_ROOT);

  registerMock("fs.list", async (args) => {
    const path = String(args.path ?? STRESS_ROOT);
    // Listing is async and takes real time; make the wait visible so the grid's
    // "载入中…" state and the measured fetch time mean something.
    await delay(30);
    if (path.startsWith("/demo/broken") || path === `${STRESS_ROOT}/读取失败`) {
      throw new Error("模拟读取失败");
    }
    if (path === `${STRESS_ROOT}/空目录`) return [];
    if (isStressPath(path)) return stressListing(path);
    return fakeTree[path] ?? [];
  });

  registerMock("fs.stat", (args): StatOut => {
    const path = String(args.path ?? "");
    if (isStressPath(path)) {
      const resolved = resolveStressPath(path);
      if (resolved) {
        return {
          path,
          isDir: resolved.isDir,
          size: resolved.isDir ? 0 : sizeFor(resolved.index),
          modifiedMs: resolved.isDir ? null : modifiedFor(resolved.index),
        };
      }
      const knownVolume = VOLUMES.some((v) => path === `${STRESS_ROOT}/${v.name}`);
      return {
        path,
        isDir: knownVolume || isStressDirPath(path),
        size: 0,
        modifiedMs: daysAgo(hashPath(path) % 400),
      };
    }
    const ent = Object.values(fakeTree).flat().find((e) => e.path === path);
    return {
      path,
      isDir: ent?.isDir ?? false,
      size: ent?.size ?? 0,
      modifiedMs: ent?.modifiedMs ?? null,
    };
  });

  registerMock("fs.readText", async (args) => {
    const path = String(args.path ?? "");
    await delay(10);
    const resolved = resolveStressPath(path);
    if (resolved && !resolved.isDir && resolved.spec.content === "binary") {
      // Binary formats must not look like text: this drives the D region's
      // "unsupported" state with a real reason instead of a blank panel.
      throw new Error(`无法以文本读取 .${resolved.spec.ext}（二进制格式）`);
    }
    if (path.startsWith("/demo/notes.txt")) {
      return "mock content of /demo/notes.txt\n第二行中文内容。";
    }
    return `模拟文本内容 of ${path}\n\n这是用于压力测试的假数据，共 ${
      resolved ? sizeFor(resolved.index).toLocaleString() : 0
    } 字节。`;
  });

  registerMock("hash.compute", (args) =>
    `mockhash-${String(args.path ?? "").length}-${String(args.algo ?? "blake3")}`,
  );

  registerMock("thumb.image", async (args) => {
    const path = String(args.path ?? "");
    const edge = Math.min(512, Math.max(16, Number(args.edge ?? 128)));
    await delay(6);
    const resolved = resolveStressPath(path);
    const ext = (path.split(".").pop() ?? "").toLowerCase();
    const decodable = resolved ? resolved.spec.thumbnail : ["jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff"].includes(ext);
    if (!decodable) {
      throw new Error(`不支持的图片格式: ${ext || "(无扩展名)"}`);
    }
    return syntheticThumb(path, edge);
  });

  // A tiny in-memory db.history store so the file-history panel has data in dev.
  const history: Record<string, Array<{ hash: string; at: number }>> = {
    "/demo/notes.txt": [
      { hash: "a1b2c3d4e5f60718", at: Date.parse("2026-10-01T09:12:00Z") },
      { hash: "9f8e7d6c5b4a3928", at: Date.parse("2026-10-03T15:40:00Z") },
    ],
  };
  registerMock("db.history.list", (args) => {
    const path = String(args.path ?? "");
    const seeded = history[path];
    if (seeded) return seeded;
    // Synthetic files get a plausible 1-3 entry history so the 历史 tab is never
    // empty during a stress run.
    const resolved = resolveStressPath(path);
    if (!resolved || resolved.isDir) return [];
    const n = 1 + (resolved.index % 3);
    return Array.from({ length: n }, (_, k) => ({
      hash: `mockhash-${resolved.index}-${k}`.padEnd(16, "0").slice(0, 16),
      at: modifiedFor(resolved.index) - k * 86_400_000 * 7,
    }));
  });
  registerMock("db.history.append", (args) => {
    const path = String(args.path ?? "");
    (history[path] ??= []).push({
      hash: String(args.hash ?? "x"),
      at: Number(args.at ?? Date.now()),
    });
    return { ok: true };
  });

  // Browser-dev plugin index: serve the built plugin frontends over the vite
  // `/dev-plugins` route so the real runtime-ESM loading path is exercised
  // without Tauri. Inside Tauri the real `plugins_list_frontend` command wins.
  // ORDER MATTERS:
  //  1. devtools-log FIRST so its global capture hooks (console / window errors /
  //     PerformanceObserver) are installed before the others run.
  //  2. container plugins next — they own the nested slot prefixes that the
  //     content plugins inject into, and mount their outlets during first render.
  //  3. content/view plugins after their containers.
  //  4. `plugin-settings` second-to-last: its gear pins itself to the bottom of the
  //     activity rail, so it must register after every other rail icon.
  //  5. slot-harness LAST: its deliberate permission violations must land in devtools-log.
  const devPlugins: PluginManifest[] = [
    devtoolsLogManifest,
    layoutPanesManifest,
    layoutViewsManifest,
    inspectorManifest,
    fileBrowserManifest,
    viewFileTreeManifest,
    viewFavoritesManifest,
    viewTagsManifest,
    fileDetailsManifest,
    fileHistoryManifest,
    previewTextManifest,
    mockDataManifest,
    settingsManifest,
    slotHarnessManifest,
  ].map((m) => {
    const manifest = m as unknown as PluginManifest;
    return {
      ...manifest,
      frontend: {
        ...manifest.frontend!,
        entry: `/dev-plugins/${manifest.name}/index.js`,
      },
    };
  });
  registerMock("plugins_list_frontend", () => devPlugins);
}
