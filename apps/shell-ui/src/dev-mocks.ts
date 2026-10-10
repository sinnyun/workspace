/**
 * Browser-dev mocks. When the shell runs under plain `vite dev` (no Tauri),
 * capability invokes would otherwise reject. These mocks let the UI and plugin
 * loading be exercised headless. Inside Tauri the real commands win
 * (invokeCapability tries Tauri first and only falls back to a mock on throw).
 *
 * The stress dataset here is deliberately **realistic** — per-format size
 * distributions (KB screenshots up to 8 GB images), believable names, mtimes
 * spread over two years, and preset sample thumbnails standing in for the Windows
 * Shell's answers — and it is served through the same `fs.list` path the file
 * browser uses, so the center grid and its virtualization are what actually
 * render it (docs/02 §4).
 */

import type {
  DiskListOut,
  FileFailureReason,
  FileItemOutcome,
  FileKind,
  FileKindOut,
  FileOperationIn,
  FileOperationItem,
  FileOperationOut,
  FileOperationProgress,
  FileOperationResult,
  FileOperationState,
  ListEntry,
  PickIn,
  PickOut,
  PluginManifest,
  ReadResourceOut,
  ReadTextOut,
  ResourceOut,
  ScanAck,
  ScanDonePayload,
  ScanNode,
  ScanProgressPayload,
  ScanSkipReason,
  ScanState,
  SearchHit,
  SearchIndexAck,
  SearchIndexDonePayload,
  SearchIndexProgressPayload,
  SearchIndexState,
  SearchQueryOut,
  SearchScope,
  SearchStatusOut,
  ShellThumbnailOut,
  StatOut,
  ThumbnailState,
} from "@my-file-manager/plugin-sdk";
import {
  decodeResourceChunk,
  Events,
  MAX_RESOURCE_CHUNK_BYTES,
  MAX_TEXT_READ_BYTES,
  RESOURCE_TTL_MS,
  SCAN_MAX_ENTRIES,
  SCAN_PROGRESS_INTERVAL_MS,
  SCAN_TREE_DEPTH,
  SEARCH_INDEX_MAX_DEPTH,
  SEARCH_MAX_PAGE,
  SEARCH_MAX_TEXT_CHARS,
  SEARCH_PROGRESS_INTERVAL_MS,
} from "@my-file-manager/plugin-sdk";
import commandPaletteManifest from "../../../plugins/plugin-command-palette/manifest.json";
import contextMenuManifest from "../../../plugins/plugin-context-menu/manifest.json";
import slotHarnessManifest from "../../../plugins/plugin-dev-slot-harness/manifest.json";
import devtoolsLogManifest from "../../../plugins/plugin-devtools-log/manifest.json";
import fileBrowserManifest from "../../../plugins/plugin-file-browser/manifest.json";
import fileDetailsManifest from "../../../plugins/plugin-file-details/manifest.json";
import fileHistoryManifest from "../../../plugins/plugin-file-history/manifest.json";
import fileOpsManifest from "../../../plugins/plugin-file-ops/manifest.json";
import inspectorManifest from "../../../plugins/plugin-inspector/manifest.json";
import layoutPanesManifest from "../../../plugins/plugin-layout-panes/manifest.json";
import layoutViewsManifest from "../../../plugins/plugin-layout-views/manifest.json";
import mockDataManifest from "../../../plugins/plugin-mock-data/manifest.json";
import pluginPreviewManifest from "../../../plugins/plugin-preview/manifest.json";
import searchManifest from "../../../plugins/plugin-search/manifest.json";
import settingsManifest from "../../../plugins/plugin-settings/manifest.json";
import storageAnalysisManifest from "../../../plugins/plugin-storage-analysis/manifest.json";
import viewFavoritesManifest from "../../../plugins/plugin-view-favorites/manifest.json";
import viewFileTreeManifest from "../../../plugins/plugin-view-file-tree/manifest.json";
import viewTagsManifest from "../../../plugins/plugin-view-tags/manifest.json";
import { FIXTURE_B64, FIXTURE_SIZES } from "./dev-fixtures";
import { bus } from "./eventbus";
import { registerMock } from "./invoke";

const MIB = 1024 * 1024;
const KIB = 1024;
const GIB = 1024 * MIB;

/** Root of the synthetic dataset. `<ROOT>/<volume>` lists that many entries. */
const STRESS_ROOT = "/stress";

/** Folder that holds the real preview bytes (roadmap P7-22). */
const FIXTURE_DIR = "/demo/预览样例";

/**
 * 每一种被预览的格式都需要**真字节**：浏览器没有盘，所以 .scratch/gen-preview-fixtures.mjs
 * 在构建期把 png / pdf / zip / wav / txt / md / rs / svg / 损坏 pdf 的二进制写进
 * `dev-fixtures.ts`，这里解码一次当作 `fs.readResource` 要切片的那段内容。
 * 查看器解析失败因此在 dev 与宿主里是同一种失败。
 */
const FIXTURE_BYTES = new Map<string, Uint8Array>(
  Object.entries(FIXTURE_B64).map(([path, base64]) => [path, decodeResourceChunk(base64)]),
);

/** 清单 = 真字节文件（长度取解码结果）+ 只有大小、没有内容的大文件。 */
const FIXTURE_LISTING: ListEntry[] = [
  ...Object.keys(FIXTURE_B64).map((path, i) =>
    entry(nameOf(path), path, false, FIXTURE_BYTES.get(path)?.length ?? 0, daysAgo(i + 1)),
  ),
  ...Object.entries(FIXTURE_SIZES).map(([path, size], i) => entry(nameOf(path), path, false, size, daysAgo(10 + i))),
].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

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
    // Failure fixtures: listed like anything else, then refused by the provider,
    // so a panel's error state is reproducible without touching a real disk.
    entry("无权限目录", "/demo/无权限目录", true, null, null),
    entry("消失目录", "/demo/消失目录", true, null, null),
    entry("坏路径", "/demo/坏路径", true, null, null),
    entry("已失效文件.txt", "/demo/已失效文件.txt", false, 12, daysAgo(1)),
    entry("无权限文件.txt", "/demo/无权限文件.txt", false, 34, daysAgo(2)),
    // 非 UTF-8 文本：宿主经 chardetng + encoding_rs 解码，dev 直接给出解码后的
    // 正文与真实编码名，界面才能显示"GBK"这类编码标记（P7-19）。
    entry("中文GBK.txt", "/demo/中文GBK.txt", false, 96, daysAgo(5)),
    // 文本预览的三种状态（ok / too-large / binary）都要能定点复现，所以演示目录
    // 里各留一个：真实大小写进清单，readText 按同一张格式表回答状态（P7-19）。
    entry("超大日志.log", "/demo/超大日志.log", false, 9 * 1024 * 1024, daysAgo(6)),
    entry("照片.jpg", "/demo/照片.jpg", false, 2 * 1024 * 1024, daysAgo(7)),
    // 扩展名是文本、内容是二进制：宿主的 chardetng 会否决并回 `binary` 状态，
    // dev 用这个路径把第三种文本状态固定复现到接替后的预览区（P7-19）。
    entry("伪文本.txt", "/demo/伪文本.txt", false, 2048, daysAgo(8)),
    // 预览通道的格式样例（真字节）：P7-22 要求每种受支持格式都能实际渲染一次。
    entry("预览样例", FIXTURE_DIR, true, null, null),
  ],
  "/demo/empty": [],
  [FIXTURE_DIR]: FIXTURE_LISTING,
  "/demo/src": [
    entry("main.rs", "/demo/src/main.rs", false, 2048, daysAgo(41)),
    entry("lib.rs", "/demo/src/lib.rs", false, 900, daysAgo(40)),
  ],
};

/** Paths whose provider fails. Messages keep the Rust `CapabilityError` prefixes
 *  (`not found:` / `permission denied:` / `invalid argument:`) so the frontend's
 *  error classification is exercised against the same vocabulary as the host. */
const LIST_ERRORS: Record<string, string> = {
  "/demo/broken": "模拟读取失败",
  [`${STRESS_ROOT}/读取失败`]: "模拟读取失败",
  "/demo/无权限目录": "permission denied: /demo/无权限目录",
  "/demo/消失目录": "not found: /demo/消失目录",
  "/demo/坏路径": "invalid argument: /demo/坏路径",
};

const STAT_ERRORS: Record<string, string> = {
  "/demo/已失效文件.txt": "not found: /demo/已失效文件.txt",
  "/demo/无权限文件.txt": "permission denied: /demo/无权限文件.txt",
};

function entry(name: string, path: string, isDir: boolean, size: number | null, modifiedMs: number | null): ListEntry {
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
  /** Windows Shell 有缩略图 handler 的格式（`shell.thumbnail.read` 才可能出图）。 */
  thumbnail: boolean;
}

const FORMATS: FormatSpec[] = [
  // 图片 — the formats a grid thumbnailer must handle, plus ones it cannot.
  {
    stems: ["IMG", "DSC", "照片", "截图"],
    ext: "jpg",
    group: "图片",
    min: 300 * KIB,
    max: 6 * MIB,
    weight: 60,
    content: "binary",
    thumbnail: true,
  },
  {
    stems: ["screenshot", "图表", "banner", "logo", "PNG导出"],
    ext: "png",
    group: "图片",
    min: 150 * KIB,
    max: 9 * MIB,
    weight: 45,
    content: "binary",
    thumbnail: true,
  },
  {
    stems: ["webp", "头图"],
    ext: "webp",
    group: "图片",
    min: 20 * KIB,
    max: 900 * KIB,
    weight: 25,
    content: "binary",
    thumbnail: true,
  },
  {
    stems: ["anim", "动图"],
    ext: "gif",
    group: "图片",
    min: 40 * KIB,
    max: 4 * MIB,
    weight: 15,
    content: "binary",
    thumbnail: true,
  },
  {
    stems: ["bitmap"],
    ext: "bmp",
    group: "图片",
    min: 1 * MIB,
    max: 24 * MIB,
    weight: 8,
    content: "binary",
    thumbnail: true,
  },
  {
    stems: ["扫描底片", "tiff"],
    ext: "tiff",
    group: "图片",
    min: 4 * MIB,
    max: 60 * MIB,
    weight: 8,
    content: "binary",
    thumbnail: true,
  },
  {
    stems: ["icon", "插画"],
    ext: "svg",
    group: "图片",
    min: 1 * KIB,
    max: 180 * KIB,
    weight: 12,
    content: "text",
    thumbnail: false,
  },
  {
    stems: ["HEIC", "iPhone照片"],
    ext: "heic",
    group: "图片",
    min: 800 * KIB,
    max: 6 * MIB,
    weight: 10,
    content: "binary",
    thumbnail: false,
  },
  {
    stems: ["RAW", "CR2底片"],
    ext: "cr2",
    group: "图片",
    min: 18 * MIB,
    max: 45 * MIB,
    weight: 6,
    content: "binary",
    thumbnail: false,
  },
  // 视频
  {
    stems: ["VID", "录屏", "camera"],
    ext: "mp4",
    group: "视频",
    min: 4 * MIB,
    max: 1200 * MIB,
    weight: 40,
    content: "binary",
    thumbnail: true,
  },
  {
    stems: ["电影", "mkv"],
    ext: "mkv",
    group: "视频",
    min: 20 * MIB,
    max: 3 * GIB,
    weight: 20,
    content: "binary",
    thumbnail: false,
  },
  {
    stems: ["mov", "手机视频"],
    ext: "mov",
    group: "视频",
    min: 8 * MIB,
    max: 800 * MIB,
    weight: 15,
    content: "binary",
    thumbnail: true,
  },
  {
    stems: ["webm", "直播回放"],
    ext: "webm",
    group: "视频",
    min: 2 * MIB,
    max: 300 * MIB,
    weight: 8,
    content: "binary",
    thumbnail: false,
  },
  // 音频
  {
    stems: ["track", "播客"],
    ext: "mp3",
    group: "音频",
    min: 2 * MIB,
    max: 12 * MIB,
    weight: 25,
    content: "binary",
    thumbnail: false,
  },
  {
    stems: ["flac", "专辑"],
    ext: "flac",
    group: "音频",
    min: 15 * MIB,
    max: 60 * MIB,
    weight: 12,
    content: "binary",
    thumbnail: false,
  },
  {
    stems: ["wav", "录音"],
    ext: "wav",
    group: "音频",
    min: 4 * MIB,
    max: 90 * MIB,
    weight: 8,
    content: "binary",
    thumbnail: false,
  },
  {
    stems: ["m4a", "语音备忘"],
    ext: "m4a",
    group: "音频",
    min: 3 * MIB,
    max: 20 * MIB,
    weight: 8,
    content: "binary",
    thumbnail: false,
  },
  // 文档
  {
    stems: ["报告", "合同", "invoice", "论文", "手册"],
    ext: "pdf",
    group: "文档",
    min: 20 * KIB,
    max: 25 * MIB,
    weight: 70,
    content: "binary",
    thumbnail: false,
  },
  {
    stems: ["方案", "模板"],
    ext: "docx",
    group: "文档",
    min: 15 * KIB,
    max: 8 * MIB,
    weight: 45,
    content: "binary",
    thumbnail: false,
  },
  {
    stems: ["数据表", "budget", "对账"],
    ext: "xlsx",
    group: "文档",
    min: 10 * KIB,
    max: 40 * MIB,
    weight: 45,
    content: "binary",
    thumbnail: false,
  },
  {
    stems: ["宣讲", "slides"],
    ext: "pptx",
    group: "文档",
    min: 1 * MIB,
    max: 120 * MIB,
    weight: 25,
    content: "binary",
    thumbnail: false,
  },
  {
    stems: ["notes", "todo", "日志摘要"],
    ext: "txt",
    group: "文档",
    min: 300,
    max: 2 * MIB,
    weight: 40,
    content: "text",
    thumbnail: false,
  },
  {
    stems: ["README", "笔记", "changelog", "设计说明"],
    ext: "md",
    group: "文档",
    min: 400,
    max: 120 * KIB,
    weight: 55,
    content: "text",
    thumbnail: false,
  },
  {
    stems: ["export", "订单", "sales"],
    ext: "csv",
    group: "文档",
    min: 2 * KIB,
    max: 300 * MIB,
    weight: 30,
    content: "text",
    thumbnail: false,
  },
  // 代码 / 配置
  {
    stems: ["main", "lib", "capability", "kernel", "thumb"],
    ext: "rs",
    group: "代码",
    min: 200,
    max: 140 * KIB,
    weight: 25,
    content: "text",
    thumbnail: false,
  },
  {
    stems: ["index", "app", "store"],
    ext: "ts",
    group: "代码",
    min: 200,
    max: 120 * KIB,
    weight: 25,
    content: "text",
    thumbnail: false,
  },
  {
    stems: ["Page", "Panel", "Widget"],
    ext: "tsx",
    group: "代码",
    min: 200,
    max: 90 * KIB,
    weight: 20,
    content: "text",
    thumbnail: false,
  },
  {
    stems: ["run", "build"],
    ext: "js",
    group: "代码",
    min: 200,
    max: 200 * KIB,
    weight: 20,
    content: "text",
    thumbnail: false,
  },
  {
    stems: ["train", "pipeline", "utils"],
    ext: "py",
    group: "代码",
    min: 200,
    max: 120 * KIB,
    weight: 25,
    content: "text",
    thumbnail: false,
  },
  {
    stems: ["server", "handler"],
    ext: "go",
    group: "代码",
    min: 200,
    max: 80 * KIB,
    weight: 10,
    content: "text",
    thumbnail: false,
  },
  {
    stems: ["package", "config", "dataset", "manifest"],
    ext: "json",
    group: "代码",
    min: 300,
    max: 30 * MIB,
    weight: 40,
    content: "text",
    thumbnail: false,
  },
  {
    stems: ["Cargo", "app"],
    ext: "toml",
    group: "代码",
    min: 200,
    max: 20 * KIB,
    weight: 15,
    content: "text",
    thumbnail: false,
  },
  {
    stems: ["ci", "compose"],
    ext: "yaml",
    group: "代码",
    min: 200,
    max: 30 * KIB,
    weight: 15,
    content: "text",
    thumbnail: false,
  },
  {
    stems: ["styles", "theme"],
    ext: "css",
    group: "代码",
    min: 200,
    max: 60 * KIB,
    weight: 15,
    content: "text",
    thumbnail: false,
  },
  {
    stems: ["index", "page"],
    ext: "html",
    group: "代码",
    min: 200,
    max: 90 * KIB,
    weight: 15,
    content: "text",
    thumbnail: false,
  },
  // 压缩包
  {
    stems: ["backup", "归档", "release"],
    ext: "zip",
    group: "压缩包",
    min: 100 * KIB,
    max: 700 * MIB,
    weight: 45,
    content: "binary",
    thumbnail: false,
  },
  {
    stems: ["archive", "全站备份"],
    ext: "7z",
    group: "压缩包",
    min: 50 * KIB,
    max: 400 * MIB,
    weight: 20,
    content: "binary",
    thumbnail: false,
  },
  {
    stems: ["node-modules", "vendor"],
    ext: "gz",
    group: "压缩包",
    min: 10 * KIB,
    max: 1500 * MIB,
    weight: 15,
    content: "binary",
    thumbnail: false,
  },
  {
    stems: ["rar", "素材包"],
    ext: "rar",
    group: "压缩包",
    min: 100 * KIB,
    max: 600 * MIB,
    weight: 10,
    content: "binary",
    thumbnail: false,
  },
  {
    stems: ["ubuntu", "Win11", "安装盘"],
    ext: "iso",
    group: "压缩包",
    min: 600 * MIB,
    max: 8 * GIB,
    weight: 12,
    content: "binary",
    thumbnail: false,
  },
  // 数据
  {
    stems: ["app", "access", "error"],
    ext: "log",
    group: "数据",
    min: 5 * KIB,
    max: 500 * MIB,
    weight: 35,
    content: "text",
    thumbnail: false,
  },
  {
    stems: ["production", "analytics", "cordis"],
    ext: "db",
    group: "数据",
    min: 1 * MIB,
    max: 2 * GIB,
    weight: 25,
    content: "binary",
    thumbnail: false,
  },
  {
    stems: ["cache", "sessions"],
    ext: "sqlite",
    group: "数据",
    min: 100 * KIB,
    max: 800 * MIB,
    weight: 15,
    content: "binary",
    thumbnail: false,
  },
  {
    stems: ["events", "features"],
    ext: "parquet",
    group: "数据",
    min: 5 * MIB,
    max: 1 * GIB,
    weight: 12,
    content: "binary",
    thumbnail: false,
  },
  {
    stems: ["blob", "dump"],
    ext: "bin",
    group: "数据",
    min: 1 * KIB,
    max: 200 * MIB,
    weight: 15,
    content: "binary",
    thumbnail: false,
  },
  // 可执行
  {
    stems: ["setup", "installer", "安装程序"],
    ext: "exe",
    group: "程序",
    min: 50 * KIB,
    max: 200 * MIB,
    weight: 25,
    content: "binary",
    thumbnail: false,
  },
  {
    stems: ["native", "dll"],
    ext: "dll",
    group: "程序",
    min: 20 * KIB,
    max: 40 * MIB,
    weight: 15,
    content: "binary",
    thumbnail: false,
  },
  {
    stems: ["msi", "套件"],
    ext: "msi",
    group: "程序",
    min: 1 * MIB,
    max: 300 * MIB,
    weight: 12,
    content: "binary",
    thumbnail: false,
  },
  {
    stems: ["app", "apk"],
    ext: "apk",
    group: "程序",
    min: 2 * MIB,
    max: 150 * MIB,
    weight: 8,
    content: "binary",
    thumbnail: false,
  },
];

/** Directory names, mixed like a real home folder. */
const DIR_STEMS = ["项目", "photos", "备份", "datasets", "docs", "素材", "downloads", "2026-Q3", "archive", "临时"];

/** The same format table decides a hand-written `/demo` file's content class too,
 *  so there is only one place that says which extensions are binary. */
const BINARY_EXT = new Set(FORMATS.filter((f) => f.content === "binary").map((f) => f.ext));

/** 名字像文本、内容像二进制的定点样例：`fs.readText` 对它回 `binary` 状态，
 *  界面那条"这不是文本文件"的分支因此在 dev 里也能取证。 */
const BINARY_TEXT_PATHS = new Set(["/demo/伪文本.txt"]);
const extOf = (path: string): string => {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
};

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
  return Math.round(f.min * (f.max / f.min) ** t);
}

/** mtime over the last ~2 years, skewed towards recent (power 1.7). */
function modifiedFor(index: number): number {
  const t = prng(index * 2 + 5) ** 1.7;
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
  const count = /^\d+$/.test(head) ? Number(head) : VOLUMES.find((v) => v.name === head)?.count;
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
    out[i] = entry(name, `${dirPath}/${name}`, isDir, isDir ? null : sizeFor(index), isDir ? null : modifiedFor(index));
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
  const dirs: ListEntry[] = VOLUMES.map((v) => entry(v.name, `${STRESS_ROOT}/${v.name}`, true, null, null));
  const sample = [
    entry("说明-压力数据.md", `${STRESS_ROOT}/说明-压力数据.md`, false, 4096, daysAgo(1)),
    entry("空目录", `${STRESS_ROOT}/空目录`, true, null, null),
    entry("读取失败", `${STRESS_ROOT}/读取失败`, true, null, null),
  ];
  return [...dirs, ...sample].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const isStressPath = (path: string): boolean => path === STRESS_ROOT || path.startsWith(`${STRESS_ROOT}/`);

// ───────────────────────────── 系统缩略图（浏览器替身） ─────────────────────────────

/**
 * `shell.thumbnail.read` 的 dev 替身。真实宿主调用 Windows Shell 的
 * `IThumbnailCache`，浏览器里拿不到它，所以这里**只返回预置样例图**，并按格式与
 * 缓存策略给出可区分的状态；绝不按文件内容绘制或生成缩略图——那是宿主要清掉的
 * 红线（docs/plugin-functional/plugin-windows-thumbnails.md）。
 * 四张样例图是构建期写死的小 PNG，与任何被"浏览"的文件都无关。
 */
const PRESET_THUMBS = {
  photo:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAABgCAYAAADVenpJAAACLklEQVR42u3S7WsNcBjG8euv8cqf4F+SJDnPz8/PjzMzx8zMzIyZmZklSZIkSUmSJEmSJEnq0nlxyoslT+Occ10vPi9+7373fX/BrQBNF75eC9B04ctmgKYLn68GabrwaSNI04WPV0I0XfiwHqLpwvvLIZouvFsL03Th7aUwTRferEZouvD6YoSmC69WojRdeHkhStOFF+ejNF14vhyj6cKzczGaLjxditN04cnZOE0XHi/Gabrw6EyCpgsPFxI0XXhwOknThfvzSZou3DuVounC3bkUTRfunEzRdOH2bJqmC7dOpGm6cHMmQ9OFG8czNF243svQdGGrl6XpwuaxLE0XNqZzNF1YP5qj6cLaVJ6mC6tH8jRdWJnM03Rh+XCBpgtLEwWaLix2izRdWOgUabow3y7SdGGuVaLpwmyzRNOFmUaZpgu9epmmC9O1Ck0XpqoVmi5MVio0XZgoV2m60ClVabrQKtZoutAo1Gi6UMvXaLpQydVpulDK1mm6kM80aLqQTTdoupBONWm6kEw2aboQTzRpuhCNt2i6sGv3HobjLfsN/d2NOnz/CMba9hPG4fDbBtB3KNq2Hxin428bwMDBSPu/+pOhhu0/IxlA34Fw55/Z6UGH8U9DH8DA/lBnRygseCwCGNgX7P4VXvyIBjCwN9D9JV70mAVgDsAcgDkAcwDmAMwBmAMwB2AOwByAOQBzAOYAzAGYAzAHYA7AHIA5AHMA5gDMAZgDsKHwDfRkLVH7rwVOAAAAAElFTkSuQmCC",
  art: "data:image/png;base64,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",
  frame:
    "data:image/png;base64,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",
  shot: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAABgCAYAAADVenpJAAABIklEQVR42u3coQ2AMBRF0Y7GBMzAkAyBZAJSiSIoQkiTMkJloT3iLvBy1Bc/DOOU1W/BCAAYAgABIAAEgAAQAAJAAAgAASAA1DCA/bjyF7qfpAoBAAAAAAAAAAAAAAAAAAD8AMC8xO4DAAAAAAAAAAAAAAAAAAAAAAAAAHAJFAACQAAIAAEgANQagHU7VQgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMCXMF/CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAqNkLjolt36KERU8AAAAASUVORK5CYII=",
} as const;

type PresetThumb = keyof typeof PRESET_THUMBS;

/** Which preset stands in for a format family. */
const THUMB_FAMILY: Record<string, PresetThumb[]> = {
  图片: ["photo", "art"],
  视频: ["frame"],
  文档: ["shot"],
};

/**
 * `cacheOnly` 时有多少比例的文件"系统里还没有缓存"。用来在 dev 里稳定地复现
 * `cache-miss` 这条正常分支，而不是让每个网格都全绿。
 */
const COLD_CACHE_EVERY = 4;

function shellThumbnail(path: string, edge: number, policy: string): ShellThumbnailOut {
  const miss = (state: ThumbnailState): ShellThumbnailOut => ({
    state,
    dataUrl: null,
    mime: null,
    edge: 0,
    fromCache: false,
  });
  const name = path.slice(path.lastIndexOf("/") + 1);
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  const resolved = resolveStressPath(path);
  if (resolved?.isDir) return miss("unsupported-type");
  // 有 Shell handler 的格式才可能有系统缩略图；其余是 unsupported-type。
  const hasHandler = resolved
    ? resolved.spec.thumbnail
    : ["jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "mp4", "mov"].includes(ext);
  if (!hasHandler) return miss("unsupported-type");
  if (policy === "cacheOnly" && hashPath(name) % COLD_CACHE_EVERY === 0) return miss("cache-miss");
  const family = THUMB_FAMILY[resolved ? resolved.spec.group : ext === "mp4" || ext === "mov" ? "视频" : "图片"] ?? [
    "shot",
  ];
  const preset = family[hashPath(path) % family.length];
  return {
    state: "ready",
    dataUrl: PRESET_THUMBS[preset],
    mime: "image/png",
    edge,
    fromCache: policy !== "cacheOnly",
  };
}

// ──────────────── 预览资源通道（浏览器替身，P7-20） ────────────────

/**
 * `fs.openResource` / `fs.readResource` / `fs.closeResource` 的 dev 替身，语义逐条对着
 * `core-shared/kernel/src/capabilities/resource.rs` 写：句柄不透明、绑定单个普通文件、
 * 目录给 `invalid argument:`、消失或无权访问给原有前缀、读过期句柄是**错误而不是空字节**、
 * 请求长度超上限时截断而非拒绝、`eof/total` 只描述真正读到的字节。
 * 界面在 dev 里走的因此就是宿主那条受限通道的形状，而不是一次 `fetch` 全文。
 */

/** 与宿主同一个上限：预览一次只看得见一个文件，忘了关也只会撑到这张表。 */
const MAX_LIVE_RESOURCES = 16;

interface LiveResource {
  path: string;
  byteLength: number;
  /** 每次成功读取都续期；宿主用单调时钟，浏览器只有 `Date.now()`。 */
  deadline: number;
}

const liveResources = new Map<string, LiveResource>();
let resourceSeq = 0;

/** 只给无界面取证用：证明"默认态一个内容字节都没读"、"返回缩略图时句柄已释放"。
 *  计数在替身内部累加，所以无论调用来自预览面板还是 harness 都算得对。
 *  `textRead` 记的是 `fs.readText`（文本类正文走这条路，不占分片句柄），
 *  这样"点了重试确实再读一次"在两种路由上都拿得出证据。 */
const devResourceCalls = { open: 0, read: 0, close: 0, bytes: 0, clamped: 0, textRead: 0 };

/** 每次分片读取的模拟耗时。默认 10ms；harness 会调大它，好让"读到一半就切走"
 *  这条分支在毫秒级 UI 里稳定可复现（与 `hash.compute` 的 900ms 同一手法）。 */
let devReadDelayMs = 10;

/** 把句柄表标记为全部过期，让 TTL 分支在几毫秒内可复现（宿主由真实时钟决定）。 */
function expireAllResources(): void {
  for (const entry of liveResources.values()) entry.deadline = Date.now() - 1;
}

function sweepResources(now: number): void {
  for (const [id, entry] of liveResources) {
    if (entry.deadline <= now) liveResources.delete(id);
  }
}

/** dev 侧的"文件存在性"：样例清单、合成数据集、失败路径三处事实源合一。 */
function devResourceSize(path: string): { byteLength: number } | null {
  const real = FIXTURE_BYTES.get(path);
  if (real) return { byteLength: real.length };
  const sized = FIXTURE_SIZES[path];
  if (sized !== undefined) return { byteLength: sized };
  const resolved = resolveStressPath(path);
  if (resolved) return resolved.isDir ? null : { byteLength: sizeFor(resolved.index) };
  const ent = currentListing(parentOf(path)).find((e) => e.path === path);
  return ent && !ent.isDir ? { byteLength: ent.size ?? 0 } : null;
}

/** dev 只有样例文件带真字节；其余合成条目按 (路径, 下标) 派生确定内容，
 *  于是分块、`eof`、`total` 这些**通道账目**是真的，而格式解析正确性只由
 *  `/demo/预览样例` 取证。文本类给可读行，二进制类给稳定字节。 */
const TEXTUAL_KINDS: ReadonlySet<FileKind> = new Set<FileKind>(["text", "code", "markdown"]);

function devBytes(path: string, offset: number, length: number): Uint8Array {
  const real = FIXTURE_BYTES.get(path);
  if (real) return real.subarray(offset, offset + length);
  const out = new Uint8Array(length);
  const seed = hashPath(path);
  if (TEXTUAL_KINDS.has(fileKindOf(path, false).kind)) {
    const line = `dev 合成文本 · ${nameOf(path)} · `;
    for (let i = 0; i < length; i += 1) {
      out[i] = i % 60 === 59 ? 0x0a : line.charCodeAt((i + seed) % line.length);
    }
  } else {
    for (let i = 0; i < length; i += 1) out[i] = ((offset + i) * 31 + seed) & 0xff;
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  // btoa 只吃二进制串；512 KiB 一块直接转字符串会把调用栈撑爆，所以分小段。
  const parts: string[] = [];
  const step = 8192;
  for (let i = 0; i < bytes.length; i += step) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + step)));
  }
  return btoa(parts.join(""));
}

/** 一次受限分片真正允许返回的字节数：既不超上限，也不越过关联大小。 */
function clampReadLength(requested: number, offset: number, total: number): number {
  const remaining = Math.max(0, total - offset);
  return Math.min(Math.max(0, requested), remaining, MAX_RESOURCE_CHUNK_BYTES);
}

function openResource(args: Record<string, unknown>): ResourceOut {
  devResourceCalls.open += 1;
  const path = String(args.path ?? "").trim();
  if (!path) throw new Error("invalid argument: path 为空");
  if (opOverlay.removed.has(path)) throw new Error(`not found: ${path}`);
  const forced = STAT_ERRORS[path];
  if (forced) throw new Error(forced);
  if (isDirectoryPath(path)) throw new Error(`invalid argument: not a regular file: ${path}`);
  const sized = devResourceSize(path);
  if (!sized) throw new Error(`not found: ${path}`);

  const now = Date.now();
  sweepResources(now);
  if (liveResources.size >= MAX_LIVE_RESOURCES) {
    throw new Error(`invalid argument: too many open previews: at most ${MAX_LIVE_RESOURCES} resources may be live`);
  }
  resourceSeq += 1;
  const handle = `res-${resourceSeq.toString(16)}-${now.toString(16)}`;
  liveResources.set(handle, { path, byteLength: sized.byteLength, deadline: now + RESOURCE_TTL_MS });
  return {
    handle,
    path,
    byteLength: sized.byteLength,
    mime: fileKindOf(path, false).mime,
    expiresMs: now + RESOURCE_TTL_MS,
  };
}

function readResource(args: Record<string, unknown>): ReadResourceOut {
  devResourceCalls.read += 1;
  const handle = String(args.handle ?? "");
  const live = liveResources.get(handle);
  const now = Date.now();
  if (!live) {
    sweepResources(now);
    throw new Error(`not found: unknown or expired resource handle ${handle}`);
  }
  if (live.deadline <= now) {
    liveResources.delete(handle);
    throw new Error(`not found: resource handle ${handle} has expired`);
  }
  // 正在被看的文件不该被自己的读取行为过期掉：先续期，再干活。
  live.deadline = now + RESOURCE_TTL_MS;

  const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)));
  const requested = Math.max(0, Math.floor(Number(args.length ?? 0)));
  const length = clampReadLength(requested, offset, live.byteLength);
  if (requested > MAX_RESOURCE_CHUNK_BYTES) devResourceCalls.clamped += 1;
  const slice = devBytes(live.path, offset, length);
  devResourceCalls.bytes += slice.length;
  return {
    handle,
    offset,
    data: toBase64(slice),
    total: live.byteLength,
    eof: offset + slice.length >= live.byteLength,
    requestToken: (args.requestToken as string | null | undefined) ?? null,
  };
}

/** 关两次是一次竞争而不是失败：答案里给 `false`，不抛错。 */
function closeResource(args: Record<string, unknown>): boolean {
  devResourceCalls.close += 1;
  return liveResources.delete(String(args.handle ?? ""));
}

/** 目录不是"可预览的字节"，但 dev 得先认得出它。 */
function isDirectoryPath(path: string): boolean {
  if (fakeTree[path] !== undefined) return true;
  if (isStressDirPath(path)) return true;
  return currentListing(parentOf(path)).some((e) => e.path === path && e.isDir);
}

// ──────────────── 文件操作 / 类型识别（浏览器替身） ────────────────

/**
 * dev 覆盖层。合成数据集本身是按需生成的，所以复制/移动/改名/新建/删除的结果
 * 记在这里，`fs.list` 与 `fs.stat` 都遵守它——列表因此能真的收敛（P7-18 要求
 * "完成后经刷新一致"），而不是只弹一条成功提示。
 */
const opOverlay = {
  removed: new Set<string>(),
  added: new Map<string, ListEntry[]>(),
};

/** 模块加载期就要用到（预览样例清单是模块级常量），所以写成函数声明而非箭头常量。 */
function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Apply the overlay to any listing so mutations are observable. */
function withOverlay(path: string, list: ListEntry[]): ListEntry[] {
  const kept = opOverlay.removed.has(path) ? [] : list.filter((e) => !opOverlay.removed.has(e.path));
  // 本次会话里新建/改名出来的条目同样能被删除，所以 `removed` 也要过一遍 `extra`。
  const extra = (opOverlay.added.get(path) ?? []).filter((e) => !opOverlay.removed.has(e.path));
  if (extra.length === 0) return kept;
  return [...kept, ...extra].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function overlayEntry(dir: string, ent: ListEntry): void {
  const list = opOverlay.added.get(dir) ?? [];
  list.push(ent);
  opOverlay.added.set(dir, list);
}

/** A short synthetic delay per item: enough for busy / cancel / partial states
 *  to be observable headless, short enough that a test does not stall. */
const ITEM_MS = 120;

/** `shell.fileOperation` 的 dev 替身：与宿主一样，调用只排队，进度与逐项结果经
 *  `shell:operation:progress` / `shell:operation:done` 事件回来；进度是
 *  **不确定**的（`indeterminate: true`、`processed: 0`），因为真实宿主的
 *  `IFileOperation` 也给我们一个可信百分比——界面必须显示不确定进度。 */
interface DevOp {
  cancelled: boolean;
  /** Kept so a cancel can re-state the running total in its progress event. */
  total: number;
  requestToken: string | null;
}
const devOps = new Map<string, DevOp>();
let opSeq = 0;

function itemOf(
  source: string,
  outcome: FileItemOutcome,
  destination: string | null = null,
  reason: FileFailureReason | null = null,
  message: string | null = null,
): FileOperationItem {
  return { source, destination, outcome, reason, message };
}

/** Why the dev provider refuses this path, in the same categories as the host. */
function refusalOf(path: string): FileFailureReason | null {
  const statErr = STAT_ERRORS[path];
  if (statErr) return statErr.startsWith("permission denied") ? "denied" : "not-found";
  if (opOverlay.removed.has(path)) return "not-found";
  return null;
}

/** The listing a dev directory currently shows (overlay included), so collision
 *  checks behave like a real filesystem rather than against the generated seed. */
function currentListing(dir: string): ListEntry[] {
  const base = dir === STRESS_ROOT ? volumeListing() : isStressPath(dir) ? stressListing(dir) : (fakeTree[dir] ?? []);
  return withOverlay(dir, base);
}

function statSize(path: string): { isDir: boolean; size: number | null; modifiedMs: number | null } {
  const resolved = resolveStressPath(path);
  if (resolved) {
    return {
      isDir: resolved.isDir,
      size: resolved.isDir ? null : sizeFor(resolved.index),
      modifiedMs: resolved.isDir ? null : modifiedFor(resolved.index),
    };
  }
  const ent = currentListing(parentOf(path)).find((e) => e.path === path);
  return { isDir: ent?.isDir ?? false, size: ent?.size ?? null, modifiedMs: ent?.modifiedMs ?? null };
}

/** Resolve one item, mutating the overlay on success. */
function runItem(op: FileOperationIn, source: string): FileOperationItem {
  const refused = refusalOf(source);
  if (refused) {
    return itemOf(source, "failed", null, refused, refused === "denied" ? "模拟：账户无权访问" : "模拟：文件已不存在");
  }
  if (op.op === "delete") {
    opOverlay.removed.add(source);
    return itemOf(source, "completed");
  }

  const destDir = op.destination ?? parentOf(source);
  const targetName = op.op === "rename" || op.op === "create" ? (op.newName ?? "") : nameOf(source);
  if (!targetName.trim() || targetName.includes("/")) {
    return itemOf(source, "failed", null, "other", "模拟：名称不合法");
  }
  const targetPath = `${destDir}/${targetName}`;
  const same = targetPath === source;
  const clash = currentListing(destDir).find((e) => e.name === targetName && e.path !== source);

  if (op.op === "create") {
    if (clash) {
      return itemOf(source, "failed", null, "exists", `模拟：${targetName} 已存在`);
    }
    overlayEntry(destDir, entry(targetName, targetPath, true, null, null));
    return itemOf(targetPath, "completed", targetPath);
  }
  if (same) {
    return itemOf(source, "completed", targetPath);
  }
  let autoRenamed = false;
  let landingName = targetName;
  if (clash) {
    if (op.conflict === "fail") {
      return itemOf(source, "failed", null, "exists", `模拟：目标已有 ${targetName}`);
    }
    if (op.conflict === "rename") {
      // What the Shell's own collision rule produces: 同名 + " - 副本".
      landingName = `${targetName.replace(/(\.[^.]*)?$/, "")} - 副本${targetName.match(/\.[^.]*$/)?.[0] ?? ""}`;
      autoRenamed = true;
    } else {
      // overwrite: the existing target loses its place in the listing.
      opOverlay.removed.add(clash.path);
    }
  }
  const landingPath = `${destDir}/${landingName}`;
  const shape = statSize(source);
  if (op.op !== "copy") opOverlay.removed.add(source);
  overlayEntry(destDir, entry(landingName, landingPath, shape.isDir, shape.size, shape.modifiedMs));
  return itemOf(source, autoRenamed ? "renamed" : "completed", landingPath);
}

async function driveDevOperation(id: string, op: FileOperationIn, total: number): Promise<void> {
  const handle = devOps.get(id);
  if (!handle) return;
  const token = op.requestToken ?? null;
  const sources = op.op === "create" ? [`${op.destination ?? ""}/${op.newName ?? ""}`] : op.sources;
  const items: FileOperationItem[] = [];
  bus.emit(Events.shellOperationProgress, {
    operationId: id,
    state: "running",
    requestToken: token,
    processed: 0,
    total,
    indeterminate: true,
    currentName: null,
  } satisfies FileOperationProgress);

  for (const source of sources) {
    await delay(ITEM_MS);
    if (handle.cancelled) {
      items.push(itemOf(source, "cancelled", null, "cancelled-by-shell", "模拟：用户取消"));
      for (const rest of sources.slice(items.length)) {
        items.push(itemOf(rest, "cancelled", null, "cancelled-by-shell", "模拟：操作已取消"));
      }
      break;
    }
    items.push(runItem(op, source));
    bus.emit(Events.shellOperationProgress, {
      operationId: id,
      state: handle.cancelled ? "cancelling" : "running",
      requestToken: token,
      processed: 0,
      total,
      indeterminate: true,
      currentName: nameOf(source),
    } satisfies FileOperationProgress);
  }

  const failed = items.filter((i) => i.outcome === "failed").length;
  const cancelled = items.filter((i) => i.outcome === "cancelled").length;
  const state: FileOperationState = handle.cancelled
    ? cancelled > 0
      ? "cancelled"
      : "failed"
    : failed === items.length
      ? "failed"
      : failed > 0
        ? "partial-failure"
        : "completed";
  // dev 只有一个虚拟盘：跨根目录的 move 视为跨卷，如实报告给界面。
  const crossVolumeMove =
    op.op === "move" && sources.some((s) => parentOf(s).split("/")[1] !== (op.destination ?? "").split("/")[1]);
  devOps.delete(id);
  bus.emit(Events.shellOperationDone, {
    operationId: id,
    state,
    requestToken: token,
    items,
    crossVolumeMove,
  } satisfies FileOperationResult);
}

// ─────────────────────── 类型识别 / 打开 / 选择器 ───────────────────────

/**
 * `file.kind` 的 dev 替身：扩展名 → 类别的映射与宿主那张表**同一份事实源**
 * （docs/plugin-functional/plugin-file-ops.md）。宿主用 `mime_guess` 得到 MIME，
 * 这里只给数据集里出现过的格式，其余返回 null。
 */
const KIND_BY_EXT: Record<string, FileKind> = {
  txt: "text",
  log: "text",
  ini: "text",
  rs: "code",
  ts: "code",
  tsx: "code",
  js: "code",
  jsx: "code",
  py: "code",
  go: "code",
  json: "code",
  toml: "code",
  yaml: "code",
  yml: "code",
  css: "code",
  html: "code",
  md: "markdown",
  markdown: "markdown",
  jpg: "image",
  jpeg: "image",
  png: "image",
  gif: "image",
  bmp: "image",
  webp: "image",
  tiff: "image",
  tif: "image",
  heic: "image",
  cr2: "image",
  nef: "image",
  svg: "vector",
  ico: "vector",
  mp4: "video",
  mov: "video",
  webm: "video",
  mkv: "container",
  avi: "container",
  mp3: "audio",
  flac: "audio",
  wav: "audio",
  m4a: "audio",
  aac: "audio",
  pdf: "pdf",
  doc: "document",
  docx: "document",
  odt: "document",
  xls: "sheet",
  xlsx: "sheet",
  ods: "sheet",
  csv: "sheet",
  ppt: "presentation",
  pptx: "presentation",
  odp: "presentation",
  zip: "archive",
  "7z": "archive",
  gz: "archive",
  rar: "archive",
  iso: "archive",
  tar: "archive",
  ttf: "font",
  otf: "font",
  woff: "font",
  woff2: "font",
  exe: "executable",
  dll: "executable",
  msi: "executable",
  bat: "executable",
  cmd: "executable",
  blend: "model",
  dwg: "model",
  step: "model",
  glb: "model",
};

function fileKindOf(path: string, isDirHint: boolean | null): FileKindOut {
  const isDir = isDirHint ?? currentListing(parentOf(path)).some((e) => e.path === path && e.isDir);
  const ext = isDir ? "" : (nameOf(path).split(".").pop() ?? "").toLowerCase();
  const hasExt = !isDir && ext !== "" && nameOf(path).toLowerCase().endsWith(`.${ext}`);
  return {
    path,
    kind: isDir ? "directory" : hasExt ? (KIND_BY_EXT[ext] ?? "unknown") : "unknown",
    extension: hasExt ? ext : "",
    mime: hasExt ? (MIME_BY_EXT[ext] ?? null) : null,
  };
}

const MIME_BY_EXT: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  wav: "audio/wav",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  iso: "application/x-iso9660-image",
  exe: "application/x-msdownload",
};

// ──────────────── 空间分析扫描 / 卷信息（P7-23 的浏览器替身） ────────────────

/**
 * `sys.scan.start` 的 dev 替身：调用只排队，进度与聚合树经 `scan:progress` /
 * `scan:done` 回来 —— 与 `shell.fileOperation` 同一套形状，界面不必为 dev 写第二套
 * 状态机。数据全部来自本文件既有的压力数据集（`fs.list` 用的同一张表），所以体积是
 * 真实压力数字而不是玩具数字。
 *
 * 遍历必须是**时间片循环**：一次扫描要过几万个目录，同步跑会把 UI 线程钉死，进度
 * 也就永远看不见（取消同样会失效）。
 */
const SCAN_LISTINGS_PER_SLICE = 6;
const SCAN_SLICE_MS = 12;
/** 进度节流与展开深度、条目预算全部取自 SDK，dev 与宿主因此受同一套上限约束。 */
const SCAN_PROGRESS_MS = SCAN_PROGRESS_INTERVAL_MS;

interface ScanSkip {
  path: string;
  reason: ScanSkipReason;
}

/** 内部遍历节点：带 parent，好把文件字节沿祖先链累加成聚合量。 */
interface ScanNodeInner {
  name: string;
  path: string;
  isDir: boolean;
  bytes: number;
  children: ScanNodeInner[];
  kinds: Record<string, number>;
  depth: number;
  parent: ScanNodeInner | null;
}

interface DevScan {
  id: string;
  root: string;
  rootInner: ScanNodeInner;
  queue: ScanNodeInner[];
  cancelled: boolean;
  finished: boolean;
  startedAt: number;
  visited: number;
  skipped: ScanSkip[];
  /** 遍历因条目预算停下时，剩下的目录就是这个原因（不是权限问题）。 */
  budgetStop: boolean;
}

const devScans = new Map<string, DevScan>();
let scanSeq = 0;

/** dev 只有一个虚拟卷：数字由根路径稳定推导，同一个根每次问都一样。 */
const DEV_VOLUME_TOTAL_BYTES = 1_000_000_000_000;

function scanSkipReason(raw: string): ScanSkipReason {
  if (/^permission denied/i.test(raw)) return "denied";
  if (/^not found/i.test(raw)) return "not-found";
  if (/^invalid argument/i.test(raw)) return "invalid-argument";
  return "read-failed";
}

/** 扫描读的就是界面在列的那份清单（含同一批强制失败点），所以跳过项与目录列表
 *  是同一份事实，不会出现「界面看得见、扫描说读不了」。 */
function listingForScan(dir: string): ListEntry[] {
  const forced = LIST_ERRORS[dir];
  if (forced) throw new Error(forced);
  return currentListing(dir);
}

function innerNode(
  name: string,
  path: string,
  isDir: boolean,
  depth: number,
  parent: ScanNodeInner | null,
): ScanNodeInner {
  return { name, path, isDir, bytes: 0, children: [], kinds: {}, depth, parent };
}

/** dev 知道哪些目录存在：不存在的根目录必须在**调用**上就被拒，和宿主回
 *  `not found:` 是同一条路径，不能让界面以为排队成功了。 */
function isKnownScanRoot(path: string): boolean {
  if (!path.trim()) return false;
  if (path === STRESS_ROOT || isStressDirPath(path)) return true;
  // 数据集卷名（`/stress/数据集-1千`）的名字里没有条目索引，resolveStressPath 认不出，
  // 但它和 `fs.stat` 一样是个存在的目录，必须能当扫描根。
  if (VOLUMES.some((v) => path === `${STRESS_ROOT}/${v.name}`)) return true;
  if (path in LIST_ERRORS) return true;
  if (fakeTree[path] !== undefined) return true;
  for (const list of opOverlay.added.values()) {
    if (list.some((e) => e.path === path && e.isDir)) return true;
  }
  return false;
}

/** 字节沿祖先链累加进每个父目录：节点的 `bytes` 就是子树总量，不用再算第二遍。 */
function addFileBytes(file: ScanNodeInner, bytes: number, ext: string): void {
  for (let p: ScanNodeInner | null = file.parent; p; p = p.parent) {
    p.bytes += bytes;
    if (ext) p.kinds[ext] = (p.kinds[ext] ?? 0) + bytes;
  }
}

/** 把一份清单挂到它的目录节点上：目录进队列等下一片，文件当场把体积交上去。
 *  两种都要留在 `children` 里，否则矩形图只剩目录、文件体积在界面上凭空消失。 */
function attachListing(scan: DevScan, node: ScanNodeInner, entries: ListEntry[]): number {
  const children: ScanNodeInner[] = [];
  for (const e of entries) {
    const child = innerNode(e.name, e.path, e.isDir, node.depth + 1, node);
    if (e.isDir) {
      scan.queue.push(child);
    } else {
      child.bytes = e.size ?? 0;
      const ext = extOf(e.name);
      if (ext) child.kinds[ext] = child.bytes;
      addFileBytes(child, child.bytes, ext);
    }
    children.push(child);
  }
  node.children = children;
  return entries.length;
}

/** 把内部遍历树裁成交付的 DTO：只向下展开到 `SCAN_TREE_DEPTH`，更深的目录留
 *  `childCount`。`cut.depth` 记录是否真的裁过，界面才知道要说"只展开到第几层"。 */
function toScanDto(node: ScanNodeInner, cut: { depth: number | null }): ScanNode {
  const dto: ScanNode = {
    name: node.name,
    path: node.path,
    isDir: node.isDir,
    bytes: node.bytes,
    kinds: node.kinds,
  };
  if (!node.isDir) return dto;
  if (node.depth >= SCAN_TREE_DEPTH) {
    if (node.children.length > 0) cut.depth = SCAN_TREE_DEPTH;
    dto.childCount = node.children.length;
    return dto;
  }
  dto.children = node.children.map((c) => toScanDto(c, cut));
  return dto;
}

function emitScanProgress(scan: DevScan, state: ScanState, currentPath: string): void {
  const payload: ScanProgressPayload = {
    scanId: scan.id,
    path: currentPath,
    entries: scan.visited,
    bytes: scan.rootInner.bytes,
    skipped: scan.skipped,
    state,
  };
  bus.emit("scan:progress", payload);
}

function finishDevScan(scan: DevScan, cancelled: boolean): void {
  if (scan.finished) return;
  scan.finished = true;
  scan.budgetStop = scan.cancelled ? false : scan.budgetStop;
  const cut = { depth: null as number | null };
  // 取消与预算截断都交付「扫到哪算哪」的部分聚合；两者都写进 skipped / cancelled，
  // 界面据此才不会把半截结果当成完整结果展示。
  if (scan.budgetStop) {
    const dropped = new Set<ScanNodeInner>();
    const parents = new Set<ScanNodeInner>();
    for (const rest of scan.queue) {
      scan.skipped.push({ path: rest.path, reason: "budget-exceeded" });
      // 没扫过的目录要从父级清单里摘掉：留着 0 字节的块就等于把它当成"扫过但是空的"。
      // 摘除按父级一次做完，逐条 filter 在几十万条目的父目录上是平方复杂度。
      rest.bytes = 0;
      dropped.add(rest);
      if (rest.parent) parents.add(rest.parent);
    }
    for (const parent of parents) {
      parent.children = parent.children.filter((c) => !dropped.has(c));
    }
    scan.queue = [];
  }
  const done: ScanDonePayload = {
    scanId: scan.id,
    tree: toScanDto(scan.rootInner, cut),
    skipped: scan.skipped,
    cancelled,
    truncatedAtDepth: cut.depth,
    elapsedMs: Math.max(0, Math.round(Date.now() - scan.startedAt)),
    // 深度上限之外的条目不在树里，条目总数只能由扫描侧给出，界面才不用估算。
    entries: scan.visited,
  };
  bus.emit("scan:done", done);
  devScans.delete(scan.id);
}

async function driveDevScan(scan: DevScan): Promise<void> {
  let lastEmit = 0;
  let current = scan.root;
  try {
    const entries = listingForScan(scan.root);
    current = scan.root;
    scan.visited = attachListing(scan, scan.rootInner, entries);
  } catch (err) {
    // 根目录本身就读不了：没有可聚合的东西，如实报告原因后直接结束。
    scan.skipped.push({ path: scan.root, reason: scanSkipReason(errorMessageOf(err)) });
    finishDevScan(scan, false);
    return;
  }

  while (!scan.finished) {
    await delay(SCAN_SLICE_MS);
    if (scan.cancelled) {
      finishDevScan(scan, true);
      return;
    }
    if (scan.visited >= SCAN_MAX_ENTRIES) {
      scan.budgetStop = true;
      finishDevScan(scan, false);
      return;
    }
    let listed = 0;
    while (listed < SCAN_LISTINGS_PER_SLICE && scan.queue.length > 0 && !scan.cancelled) {
      const node = scan.queue.shift();
      if (!node) break;
      current = node.path;
      try {
        scan.visited += attachListing(scan, node, listingForScan(node.path));
      } catch (err) {
        scan.skipped.push({ path: node.path, reason: scanSkipReason(errorMessageOf(err)) });
        // 读不了的目录没被扫过：从父级清单里摘掉，聚合量因此不包含它。
        node.bytes = 0;
        const parent = node.parent;
        if (parent) parent.children = parent.children.filter((c) => c !== node);
      }
      listed++;
    }
    if (scan.cancelled) {
      finishDevScan(scan, true);
      return;
    }
    if (scan.queue.length === 0) {
      finishDevScan(scan, false);
      return;
    }
    if (Date.now() - lastEmit >= SCAN_PROGRESS_MS) {
      lastEmit = Date.now();
      emitScanProgress(scan, "running", current);
    }
  }
}

/** `Error(String(err))` 会带上 `Error: ` 前缀，分类只看 provider 给的那段文本。 */
function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ──────────────── 名称检索索引（P7-29 的浏览器替身） ────────────────

/**
 * `search.*` 的 dev 替身。索引是内存里的一张表，行来自 `fs.list` 用的同一份清单，
 * 所以"搜到的路径"和"点得开的路径"不会分裂成两个事实。与宿主有两处刻意的不同，
 * 都只关乎快慢、不关乎答案：
 *
 * 1. 浏览器没有 SQLite，检索一律是**子串扫描**（不分三字符上下），排序按名称而不是
 *    bm25。契约里"顺序即相关性"由宿主负责；dev 保证的是同一批命中与同一套分页语义
 *    （`offset` + `hasMore`），界面不需要为 dev 写第二条分支。
 * 2. 条目上限远小于宿主：给浏览器索引五十万个名字会把标签页吃掉几百 MB，还会在切片
 *    间隙卡顿。到上限即 `partial`，和宿主被上限截断是同一个状态，所以"索引不完整"
 *    的界面在 dev 里也能定点复现。
 *
 * 遍历同样是时间片循环（同步跑会钉死 UI 线程，进度与取消就都失效），终态与进度走
 * 冻结的 `search:index-progress` / `search:index-done`。
 */
const DEV_SEARCH_MAX_ROWS = 120_000;
const SEARCH_LISTINGS_PER_SLICE = 6;
const SEARCH_SLICE_MS = 12;
/** 与宿主 `DEFAULT_PAGE` 同一个默认页长，界面不传 limit 时两边一致。 */
const DEV_SEARCH_DEFAULT_PAGE = 50;

interface DevSearchRow {
  path: string;
  name: string;
  parent: string;
  isDir: boolean;
  size: number | null;
  modifiedMs: number | null;
  root: string;
}

interface DevSearchJob {
  id: string;
  roots: string[];
  queue: Array<{ path: string; root: string; depth: number }>;
  cancelled: boolean;
  finished: boolean;
  startedAt: number;
  /** 本轮交出去的行数，进度事件报它；`devSearch.rows.size` 是全索引的量。 */
  walked: number;
  skipped: number;
  current: string;
  hitCeiling: boolean;
}

/** 索引本体跨任务存活：查询读它，`search.status` 也读它。 */
const devSearch = {
  rows: new Map<string, DevSearchRow>(),
  roots: [] as string[],
  state: "empty" as SearchIndexState,
  detail: null as string | null,
  lastJobMs: 0,
};

const devSearchJobs = new Map<string, DevSearchJob>();
let searchSeq = 0;

/** 一个目录的稳定写法：去掉尾部分隔符，`/` 本身除外。同一个目录的两种写法必须
 *  落到同一个根标签上，否则刷新会删掉别人的行、留下自己的。 */
function devRootLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.replace(/\/+$/, "") || "/";
}

function underRoot(child: string, parent: string): boolean {
  if (child === parent) return false;
  return parent === "/" ? child.startsWith("/") : child.startsWith(`${parent}/`);
}

/** 只留最外层的根：一行只属于一个根，被两个根覆盖的子树谁都无法单独刷新。 */
function pruneDevRoots(labels: string[]): string[] {
  const kept: string[] = [];
  for (const label of [...new Set(labels)].sort()) {
    if (!kept.some((outer) => underRoot(label, outer))) kept.push(label);
  }
  return kept;
}

/** 有活就一律 `indexing`：文件里上次记的状态不能盖过正在增长的条目数。 */
function devSearchState(): SearchIndexState {
  return devSearchJobs.size > 0 ? "indexing" : devSearch.state;
}

function dropDevRootRows(root: string): void {
  for (const [path, row] of devSearch.rows) {
    if (row.root === root) devSearch.rows.delete(path);
  }
}

function devRootRow(root: string): DevSearchRow {
  return {
    path: root,
    name: nameOf(root) || root,
    parent: parentOf(root),
    isDir: true,
    size: null,
    modifiedMs: null,
    root,
  };
}

/** 把一份清单写成索引行，目录排进下一片。返回 false 表示这一轮到了上限。
 *  深度上界与宿主同一条规则（`depth + 1 < SEARCH_INDEX_MAX_DEPTH` 才继续下钻），
 *  否则同一句话在 dev 与宿主里会给出不同的行集。 */
function indexDevListing(job: DevSearchJob, dir: string, root: string, depth: number, entries: ListEntry[]): boolean {
  for (const e of entries) {
    job.walked++;
    // 目录既没有大小也没有内容时间（和 `fs.list` 一样），命中行因此和列表行读起来
    // 完全一致。
    devSearch.rows.set(e.path, {
      path: e.path,
      name: e.name,
      parent: dir,
      isDir: e.isDir,
      size: e.isDir ? null : e.size,
      modifiedMs: e.isDir ? null : e.modifiedMs,
      root,
    });
    if (e.isDir && depth + 1 < SEARCH_INDEX_MAX_DEPTH) job.queue.push({ path: e.path, root, depth: depth + 1 });
    if (job.walked >= DEV_SEARCH_MAX_ROWS) {
      job.hitCeiling = true;
      return false;
    }
  }
  return true;
}

function emitSearchProgress(job: DevSearchJob): void {
  bus.emit(Events.searchIndexProgress, {
    jobId: job.id,
    state: "indexing",
    entries: job.walked,
    currentPath: job.current,
    elapsedMs: Math.max(0, Date.now() - job.startedAt),
  } satisfies SearchIndexProgressPayload);
}

function finishDevSearch(job: DevSearchJob, cancelled: boolean): void {
  if (job.finished) return;
  job.finished = true;
  const partial = cancelled || job.hitCeiling;
  devSearch.state = partial ? "partial" : "ready";
  devSearch.detail = cancelled
    ? "索引任务已取消，结果不完整"
    : job.hitCeiling
      ? `达到条目上限 ${DEV_SEARCH_MAX_ROWS}，索引不完整`
      : null;
  devSearch.lastJobMs = Math.max(0, Date.now() - job.startedAt);
  // 刷新只保证自己根的行是真的，根集合因此是并集；重建才是替换。
  devSearch.roots = job.roots.length ? [...new Set([...devSearch.roots, ...job.roots])].sort() : devSearch.roots;
  bus.emit(Events.searchIndexDone, {
    jobId: job.id,
    state: devSearch.state,
    entries: devSearch.rows.size,
    roots: [...devSearch.roots],
    elapsedMs: devSearch.lastJobMs,
    cancelled,
    detail: devSearch.detail,
  } satisfies SearchIndexDonePayload);
  devSearchJobs.delete(job.id);
}

async function driveDevSearch(job: DevSearchJob): Promise<void> {
  let lastEmit = 0;
  for (const root of job.roots) {
    // 根目录自己也是一行：搜"这张盘上有没有叫 X 的文件夹"时，它得能被找到。
    devSearch.rows.set(root, devRootRow(root));
    job.walked++;
    job.queue.push({ path: root, root, depth: 0 });
  }
  while (!job.finished) {
    await delay(SEARCH_SLICE_MS);
    if (job.cancelled) {
      finishDevSearch(job, true);
      return;
    }
    let listed = 0;
    while (listed < SEARCH_LISTINGS_PER_SLICE && job.queue.length > 0 && !job.cancelled) {
      const node = job.queue.shift();
      if (!node) break;
      job.current = node.path;
      try {
        if (!indexDevListing(job, node.path, node.root, node.depth, listingForScan(node.path))) {
          finishDevSearch(job, false);
          return;
        }
      } catch {
        // 读不了的目录计入 skipped：索引是缓存，缺一段就要能说清缺了，而不是安静地
        // 让"没有结果"变成谎话。
        job.skipped++;
      }
      listed++;
    }
    if (job.cancelled) {
      finishDevSearch(job, true);
      return;
    }
    if (job.queue.length === 0) {
      finishDevSearch(job, false);
      return;
    }
    if (Date.now() - lastEmit >= SEARCH_PROGRESS_INTERVAL_MS) {
      lastEmit = Date.now();
      emitSearchProgress(job);
    }
  }
}

/** 根必须是目录，且必须真的存在——和宿主一样在**调用**上就拒，不能让界面等一个
 *  永远不会描述任何东西的 `search:index-done`。 */
function assertDevSearchRoot(label: string): void {
  let listed: ListEntry | undefined;
  try {
    listed = currentListing(parentOf(label)).find((e) => e.path === label);
  } catch {
    listed = undefined;
  }
  if (listed && !listed.isDir) throw new Error(`invalid argument: 不是目录：${label}`);
  if (!isKnownScanRoot(label)) throw new Error(`not found: ${label}`);
}

// ─────────────────────── registration ───────────────────────

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
    const forced = LIST_ERRORS[path];
    if (forced) throw new Error(forced);
    if (path === `${STRESS_ROOT}/空目录`) return withOverlay(path, []);
    if (isStressPath(path)) return withOverlay(path, stressListing(path));
    return withOverlay(path, fakeTree[path] ?? []);
  });

  registerMock("fs.stat", (args): StatOut => {
    const path = String(args.path ?? "");
    if (opOverlay.removed.has(path)) throw new Error(`not found: ${path}`);
    const forced = STAT_ERRORS[path];
    if (forced) throw new Error(forced);
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
    const ent = [...Object.values(fakeTree).flat(), ...[...opOverlay.added.values()].flat()].find(
      (e) => e.path === path,
    );
    return {
      path,
      isDir: opOverlay.added.get(parentOf(path))?.some((e) => e.path === path) ? true : (ent?.isDir ?? false),
      size: ent?.size ?? 0,
      modifiedMs: ent?.modifiedMs ?? null,
    };
  });

  // `fs.readText` 的答案是**状态 + 正文**，不是一个裸字符串：超限与二进制必须能被
  // 界面区分开（P7-19）。dev 用数据集的格式表决定状态。
  registerMock("fs.readText", async (args): Promise<ReadTextOut> => {
    devResourceCalls.textRead += 1;
    const path = String(args.path ?? "");
    await delay(10);
    const base = (state: ReadTextOut["state"], extra: Partial<ReadTextOut> = {}): ReadTextOut => ({
      path,
      state,
      text: null,
      encoding: null,
      byteLength: 0,
      ...extra,
    });
    if (opOverlay.removed.has(path)) throw new Error(`not found: ${path}`);
    const forced = STAT_ERRORS[path];
    if (forced) throw new Error(forced);
    const resolved = resolveStressPath(path);
    const size = resolved ? sizeFor(resolved.index) : (statSize(path).size ?? 96);
    const isBinary = BINARY_TEXT_PATHS.has(path)
      ? true
      : resolved
        ? !resolved.isDir && resolved.spec.content === "binary"
        : BINARY_EXT.has(extOf(path));
    if (isBinary) {
      // 二进制格式绝不能看起来像文本：界面据此给出可区分的中文原因（P7-19）。
      return base("binary", { byteLength: size });
    }
    if (size > MAX_TEXT_READ_BYTES) {
      return base("too-large", { byteLength: size });
    }
    if (path === "/demo/中文GBK.txt") {
      return base("ok", {
        text: "中文 GBK 文本：宿主用 chardetng 猜测、encoding_rs 解码。\n第二行也是中文。",
        encoding: "GBK",
        byteLength: 96,
      });
    }
    // 预览样例目录里的文本是**真字节**，readText 就把同一份字节按 UTF-8 解码回来：
    // 两条通道对同一个文件必须说同一句话（样例目录是事实源，P7-19 与 P7-22 共用）。
    const fixture = FIXTURE_BYTES.get(path);
    if (fixture) {
      return base("ok", {
        text: new TextDecoder("utf-8").decode(fixture),
        encoding: "UTF-8",
        byteLength: fixture.length,
      });
    }
    return base("ok", {
      text:
        path === "/demo/notes.txt"
          ? "mock content of /demo/notes.txt\n第二行中文内容。"
          : `模拟文本内容 of ${path}\n\n这是用于压力测试的假数据，共 ${size.toLocaleString()} 字节。`,
      encoding: "UTF-8",
      byteLength: size,
    });
  });

  // 预览通道三条能力一起注册。分片读取默认带 10ms 延迟，只为了让"读取中 + 百分比"
  // 这一帧在界面上停留得住；语义本身（上限、续期、死句柄报错）全部同步。
  registerMock("fs.openResource", openResource);
  registerMock(
    "fs.readResource",
    (args): Promise<ReadResourceOut> => delay(devReadDelayMs).then(() => readResource(args)),
  );
  registerMock("fs.closeResource", closeResource);

  // Harness 取证入口：内容读了几个字节、句柄表还剩谁、以及把 TTL 提前拉满。
  (window as unknown as Record<string, unknown>).__fmResource = {
    calls: devResourceCalls,
    live: () => [...liveResources.keys()],
    expire: expireAllResources,
    slow: (ms: number): void => {
      devReadDelayMs = ms;
    },
    open: openResource,
    read: readResource,
    close: closeResource,
    reset: () => {
      liveResources.clear();
      devResourceCalls.open = 0;
      devResourceCalls.read = 0;
      devResourceCalls.close = 0;
      devResourceCalls.bytes = 0;
      devResourceCalls.clamped = 0;
      devResourceCalls.textRead = 0;
    },
  };

  // Hashing is a real background task: it resolves long after a click, which is
  // what makes the details panel's "计算中…" state and its stale-answer guard
  // observable in the browser (P7-5).
  registerMock("hash.compute", async (args) => {
    await delay(900);
    return `mockhash-${String(args.path ?? "").length}-${String(args.algo ?? "blake3")}`;
  });

  // 浏览器里没有 Windows Shell，所以这条能力返回预置样例图或明确的
  // unsupported 状态；140ms 的延迟让占位、取消与过期回填在 dev 里可观察。
  registerMock("shell.thumbnail.read", async (args) => {
    const path = String(args.path ?? "");
    const edge = Math.min(512, Math.max(16, Number(args.edge ?? 128)));
    await delay(140);
    return shellThumbnail(path, edge, String(args.policy ?? "extract"));
  });

  // 浏览器里没有 Shell 文件操作引擎：排队 + 事件回报的**形状**与宿主完全一致，
  // 逐项结果写进 opOverlay，所以文件操作插件能在此跑到 completed / partial /
  // cancelled 各分支，且列表真的变化。
  registerMock("shell.fileOperation", (args): FileOperationOut => {
    const req = args as unknown as FileOperationIn;
    const invalid = (why: string): never => {
      throw new Error(`invalid argument: ${why}`);
    };
    const sources = req.sources ?? [];
    if (req.op === "create") {
      if (!req.destination || !req.newName?.trim()) invalid("新建需要目标目录与名称");
    } else if (sources.length === 0) {
      invalid("没有选中的条目");
    }
    if ((req.op === "rename" || req.op === "create") && sources.length > 1) {
      invalid("重命名/新建一次只能处理一项");
    }
    if ((req.op === "copy" || req.op === "move") && !req.destination) {
      invalid("复制/移动需要目标目录");
    }
    const id = `dev-op-${++opSeq}`;
    const total = req.op === "create" ? 1 : sources.length;
    devOps.set(id, { cancelled: false, total, requestToken: req.requestToken ?? null });
    void driveDevOperation(id, req, total);
    return { operationId: id, state: "queued", total, indeterminate: true };
  });

  registerMock("shell.cancelFileOperation", (args): boolean => {
    const id = String(args.operationId ?? "");
    const handle = devOps.get(id);
    if (!handle) return false;
    handle.cancelled = true;
    // 宿主在取消被接受后也会先把"正在取消"播出去（QueryCancel 到 Shell 真正停下
    // 之间还有一段路），界面必须能显示这个中间态。
    const total = handle.total;
    bus.emit(Events.shellOperationProgress, {
      operationId: id,
      state: "cancelling",
      requestToken: handle.requestToken,
      processed: 0,
      total,
      indeterminate: true,
      currentName: null,
    } satisfies FileOperationProgress);
    return true;
  });

  registerMock("shell.openPath", (args): boolean => {
    const path = String(args.path ?? "");
    if (!path.trim()) throw new Error("invalid argument: path 为空");
    if (opOverlay.removed.has(path) || STAT_ERRORS[path]?.startsWith("not found")) {
      throw new Error(`not found: ${path}`);
    }
    if (STAT_ERRORS[path]?.startsWith("permission denied")) {
      throw new Error(`permission denied: ${path}`);
    }
    return true;
  });

  registerMock("shell.revealItemInDir", (args): boolean => {
    const path = String(args.path ?? "");
    if (!path.trim()) throw new Error("invalid argument: path 为空");
    return true;
  });

  // 原生对话框在浏览器里不存在：给定一个**确定**的答案，让依赖选择器的流程
  // （新建/复制到/存储分析选根目录）在无头测试里可以走完整条路径。
  registerMock("shell.pickFile", async (args): Promise<PickOut> => {
    await delay(30);
    const req = args as unknown as PickIn;
    return {
      paths: [req.multiple ? "/demo/notes.txt" : "/demo/报告.docx"],
      cancelled: false,
    };
  });

  registerMock("shell.pickDirectory", async (): Promise<PickOut> => {
    await delay(30);
    return { paths: ["/demo/src"], cancelled: false };
  });

  registerMock("file.kind", (args): FileKindOut => {
    const hint = args.isDir;
    return fileKindOf(String(args.path ?? ""), hint === undefined || hint === null ? null : Boolean(hint));
  });

  // `sys.disk.list` 的 dev 替身：浏览器里没有卷枚举，所以给一个稳定的虚拟卷，
  // 字段与规划中的宿主 DTO 同名（真实数字只能在 Tauri 里取证）。
  registerMock("sys.disk.list", async (args): Promise<DiskListOut> => {
    const path = String(args.path ?? "");
    await delay(20);
    if (!path.trim()) throw new Error("invalid argument: 需要先选择根目录");
    const usedRatio = 0.45 + (hashPath(path.slice(0, 1)) % 400) / 1000;
    const usedBytes = Math.round(DEV_VOLUME_TOTAL_BYTES * usedRatio);
    return {
      path,
      volumes: [
        {
          rootPath: path.slice(0, 1) === "/" ? "/" : "C:",
          label: "模拟卷",
          filesystem: "NTFS",
          totalBytes: DEV_VOLUME_TOTAL_BYTES,
          usedBytes,
          freeBytes: DEV_VOLUME_TOTAL_BYTES - usedBytes,
        },
      ],
    };
  });

  // `sys.scan.start` 只排队；进度与聚合树走 scan:progress / scan:done，与
  // `shell.fileOperation` 的「确认 + 事件」分工完全一致（P7-23）。
  registerMock("sys.scan.start", (args): ScanAck => {
    const rootPath = String(args.rootPath ?? "");
    if (!rootPath.trim()) throw new Error("invalid argument: 需要先选择根目录");
    if (!isKnownScanRoot(rootPath)) throw new Error(`not found: ${rootPath}`);
    const id = `dev-scan-${++scanSeq}`;
    const scan: DevScan = {
      id,
      root: rootPath,
      rootInner: innerNode(nameOf(rootPath) || rootPath, rootPath, true, 0, null),
      queue: [],
      cancelled: false,
      finished: false,
      startedAt: Date.now(),
      visited: 0,
      skipped: [],
      budgetStop: false,
    };
    devScans.set(id, scan);
    void driveDevScan(scan);
    return { scanId: id, state: "queued", rootPath };
  });

  registerMock("sys.scan.cancel", (args): boolean => {
    const scan = devScans.get(String(args.scanId ?? ""));
    if (!scan || scan.finished) return false;
    scan.cancelled = true;
    // 只置标记，不发中间态：`ScanState` 没有 cancelling，真正停下由时间片边界决定，
    // 终态一定带 `cancelled: true`（与宿主 `sys.scan.cancel` 同一行为）。
    return true;
  });

  // ── 名称检索（P7-29）：`search.index.start` 只排队，进度与终态走事件；查询读的是
  // 上面那张内存索引。分页语义与宿主一致（`offset` + `hasMore`，`total` 是索引知道的
  // 匹配总数，不是本页条数），界面的增量加载在 dev 与宿主里是同一段代码。
  registerMock(
    "search.status",
    (): SearchStatusOut => ({
      state: devSearchState(),
      entries: devSearch.rows.size,
      roots: [...devSearch.roots],
      lastJobMs: devSearch.lastJobMs,
      detail: devSearch.detail,
    }),
  );

  registerMock("search.query", (args): SearchQueryOut => {
    const startedAt = Date.now();
    // 截断而不是拒绝，和宿主同一句理由：检索词是用户正在打的字。
    const text = String(args.text ?? "")
      .trim()
      .slice(0, SEARCH_MAX_TEXT_CHARS);
    if (!text) throw new Error("invalid argument: search.query 需要检索词");
    const scope = (args.scope ?? "all") as SearchScope;
    const within = devRootLabel(String(args.within ?? ""));
    const limit = Math.min(Math.max(Number(args.limit ?? DEV_SEARCH_DEFAULT_PAGE) || 1, 1), SEARCH_MAX_PAGE);
    const offset = Math.max(Number(args.offset ?? 0) || 0, 0);
    const state = devSearchState();
    const needle = text.toLowerCase();
    const matched = [...devSearch.rows.values()]
      .filter((row) => {
        if (scope === "file" && row.isDir) return false;
        if (scope === "dir" && !row.isDir) return false;
        if (within && !(row.parent === within || underRoot(row.parent, within))) return false;
        return row.name.toLowerCase().includes(needle);
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const hits = matched.slice(offset, offset + limit).map(
      (row): SearchHit => ({
        path: row.path,
        name: row.name,
        parent: row.parent,
        isDir: row.isDir,
        size: row.size,
        modifiedMs: row.modifiedMs,
      }),
    );
    return {
      text,
      scope,
      tookMs: Math.max(0, Date.now() - startedAt),
      total: matched.length,
      offset,
      hasMore: offset + hits.length < matched.length,
      hits,
      state,
    };
  });

  registerMock("search.index.start", (args): SearchIndexAck => {
    const requestedRaw = Array.isArray(args.roots) ? (args.roots as unknown[]).map((root) => String(root)) : [];
    const labels = pruneDevRoots(
      (requestedRaw.length ? requestedRaw : devSearch.roots.length ? devSearch.roots : [STRESS_ROOT])
        .map(devRootLabel)
        .filter((label) => label !== ""),
    );
    if (!labels.length) {
      throw new Error("invalid argument: search.index.start 需要一个绝对目录");
    }
    // 根在调用上就验，顺序也与宿主一致：先逐个拒非目录/不存在，再判空，最后才看上界。
    for (const label of labels) assertDevSearchRoot(label);
    if (devSearchJobs.size >= 1) {
      throw new Error("invalid argument: 已有一个索引任务在运行（上限 1），请先取消它");
    }
    const rebuild = args.rebuild === true;
    if (rebuild) {
      devSearch.rows.clear();
      devSearch.roots = [];
    } else {
      for (const label of labels) dropDevRootRows(label);
    }
    const id = `dev-search-index-${++searchSeq}`;
    const job: DevSearchJob = {
      id,
      roots: labels,
      queue: [],
      cancelled: false,
      finished: false,
      startedAt: Date.now(),
      walked: 0,
      skipped: 0,
      current: labels[0] ?? "",
      hitCeiling: false,
    };
    devSearchJobs.set(id, job);
    void driveDevSearch(job);
    return { jobId: id, roots: labels, state: "indexing" };
  });

  registerMock("search.index.cancel", (args): boolean => {
    const job = devSearchJobs.get(String(args.jobId ?? ""));
    if (!job || job.finished) return false;
    job.cancelled = true;
    return true;
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
    let list = history[path];
    if (!list) {
      list = [];
      history[path] = list;
    }
    list.push({
      hash: String(args.hash ?? "x"),
      at: Number(args.at ?? Date.now()),
    });
    return { ok: true };
  });

  // db.tags — the tags store (P7-32), owned by plugin-view-tags. Mirrors the
  // host's run_db dispatch: one kv row per tag, value `{seq, members}`; keyless
  // `list` answers rows as `[key, value]` tuples (a keyed list reads the ordered
  // log, which the tags store never appends to). Dev persistence is a dev-only
  // localStorage key so a reload keeps tags for chip / tag-view assertions;
  // inside Tauri the real SQLite store wins.
  const TAGS_DEV_KEY = "fm.dev-mocks.db.tags.v1";
  const tagRows = new Map<string, unknown>();
  try {
    const raw = localStorage.getItem(TAGS_DEV_KEY);
    if (raw) {
      for (const [key, value] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
        tagRows.set(key, value);
      }
    }
  } catch {
    /* start empty */
  }
  const persistTagRows = (): void => {
    try {
      localStorage.setItem(TAGS_DEV_KEY, JSON.stringify(Object.fromEntries(tagRows)));
    } catch {
      /* session-only store */
    }
  };
  registerMock("db.tags.list", (args) => {
    if (args.key !== undefined || args.path !== undefined) return [];
    return [...tagRows.entries()].map(([key, value]) => [key, value]);
  });
  registerMock("db.tags.put", (args) => {
    tagRows.set(String(args.key ?? ""), args.value ?? null);
    persistTagRows();
    return true;
  });
  registerMock("db.tags.delete", (args) => {
    tagRows.delete(String(args.key ?? ""));
    persistTagRows();
    return true;
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
  //  4. context-menu before the views: it claims the panel provider on mount, so it
  //     must be in the tree when the contributors register their items.
  //  5. `plugin-command-palette` claims the command launcher on mount and draws
  //     the `command-palette` slot; it sits with the view plugins, before the
  //     commands (`search.open` / `search.index-current`) can ever be invoked.
  //  6. `plugin-settings` second-to-last: its gear pins itself to the bottom of the
  //     activity rail, so it must register after every other rail icon.
  //  7. slot-harness LAST: its deliberate permission violations must land in devtools-log.
  const devPlugins: PluginManifest[] = [
    devtoolsLogManifest,
    layoutPanesManifest,
    layoutViewsManifest,
    inspectorManifest,
    contextMenuManifest,
    fileBrowserManifest,
    viewFileTreeManifest,
    viewFavoritesManifest,
    viewTagsManifest,
    fileOpsManifest,
    storageAnalysisManifest,
    searchManifest,
    commandPaletteManifest,
    fileDetailsManifest,
    fileHistoryManifest,
    pluginPreviewManifest,
    mockDataManifest,
    settingsManifest,
    slotHarnessManifest,
  ].map((m) => {
    const manifest = m as unknown as PluginManifest;
    return {
      ...manifest,
      frontend: {
        ...(manifest.frontend ?? {}),
        entry: `/dev-plugins/${manifest.name}/index.js`,
      },
    };
  });
  registerMock("plugins_list_frontend", () => devPlugins);
}
