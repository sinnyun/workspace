/**
 * `plugin-preview` — the one file preview in the D 信息页 `preview-zone`
 * (docs/plugin-functional/plugin-preview.md, roadmap P7-21/22).
 *
 * Two modes, and the difference between them is the whole point:
 * - **缩略图** (default for every newly focused file): one
 *   `shell.thumbnail.read` call — the Windows Shell's own picture, or a type
 *   badge. No viewer is created, no byte of the file is read.
 * - **文件预览** (only after the user clicks): a read-only, path-bound,
 *   short-lived `fs.openResource` handle, bounded `fs.readResource` chunks, then
 *   Open File Viewer renders the assembled bytes.
 *
 * Nothing here hands the WebView a `file:`/asset URL or an absolute path it did
 * not already have, and nothing persists the mode: switching focus resets to
 * 缩略图 so one careless click cannot start pulling 500 MB files.
 *
 * Leaving the viewer mode (button, focus change, unmount) aborts the chunk loop,
 * revokes the handle and destroys the viewer — the request sequence number is
 * what makes a late answer from the previous file unable to paint itself onto
 * this one.
 */

import { Badge, Button, Group, NativeSelect, Stack, Text, TextInput } from "@mantine/core";
import {
  Capabilities,
  decodeResourceChunk,
  Events,
  errorMessage,
  type FileKind,
  type FileKindOut,
  formatSize,
  type HostMetaState,
  MAX_PREVIEW_BYTES,
  MAX_RESOURCE_CHUNK_BYTES,
  MAX_TEXT_READ_BYTES,
  type PluginHost,
  type PreviewState,
  type PreviewStateChangedArgs,
  type ReadResourceOut,
  type ReadTextOut,
  type Ref,
  type ResourceOut,
  type ShellThumbnailOut,
  type SlotProps,
} from "@my-file-manager/plugin-sdk";
import {
  archivePlugin,
  audioPlugin,
  imagePlugin,
  officePlugin,
  pdfPlugin,
  textPlugin,
  videoPlugin,
} from "@open-file-viewer/core";
// `?inline`: a runtime ESM plugin has no build step that could emit a separate
// stylesheet the base would link, so the viewer's CSS rides inside this bundle
// and is attached as one `<style>` element on activation. Every rule in it is
// scoped to `.ofv-*`, so nothing here reaches the app's own markup.
import ofvStyles from "@open-file-viewer/core/style.css?inline";
import { FileViewer } from "@open-file-viewer/react";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

const VIEWER_STYLE_ID = "ofv-viewer-style";

export function activate(_host: PluginHost): void {
  if (document.getElementById(VIEWER_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = VIEWER_STYLE_ID;
  style.textContent = ofvStyles;
  document.head.append(style);
}

type Mode = "thumbnail" | "viewer";

/** The zone's viewer half, in the 12 states the functional spec names — the SDK
 *  owns the union because `preview:state:changed` publishes it. */
type Phase = PreviewState;

const THUMB_EDGE = 256;

function nameOf(target: string): string {
  const idx = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"));
  return idx >= 0 ? target.slice(idx + 1) : target;
}

/** Kinds the shipped Open File Viewer plugin set can attempt. Anything else is
 *  refused *before* reading a byte, with the accurate boundary in Chinese —
 *  claiming "全格式可预览" is the failure mode the spec names. */
const VIEWABLE_KINDS: ReadonlySet<FileKind> = new Set<FileKind>([
  "text",
  "code",
  "markdown",
  "image",
  "pdf",
  "audio",
  "video",
  "archive",
  "document",
  "sheet",
  "presentation",
]);

/** Text-ish kinds go through `fs.readText` instead of the byte channel: the
 *  encoding guess (chardetng + encoding_rs) lives in the kernel, and Open File
 *  Viewer only ever assumes UTF-8 — handing it raw GBK bytes would render
 *  mojibake, which P7-19 already proved we must not do. */
const TEXTUAL_KINDS: ReadonlySet<FileKind> = new Set<FileKind>(["text", "code", "markdown"]);

const KIND_LABELS: Record<string, string> = {
  text: "文本",
  code: "代码",
  markdown: "Markdown",
  image: "图片",
  vector: "矢量图",
  pdf: "PDF",
  audio: "音频",
  video: "视频",
  container: "影音容器",
  archive: "压缩包",
  document: "文档",
  sheet: "表格",
  presentation: "演示文稿",
  font: "字体",
  executable: "可执行文件",
  model: "三维模型",
  directory: "文件夹",
  unknown: "未知类型",
};

/** pdf.js needs three things outside its own module: a worker script, the CJK
 *  cmap tables and the standard font data. Left alone it fetches all three from
 *  jsDelivr, which would make a local preview depend on the network — so
 *  `scripts/prepare-pdf-assets.mjs` copies them next to this bundle at build
 *  time and the URLs are resolved against **this module**, which is what works
 *  both over `/dev-plugins/…` in dev and over `plugin://…` in the host. */
const PDF_ASSETS = {
  // `@vite-ignore` on purpose: these files are copied into `dist/` after the
  // bundle is written (scripts/prepare-pdf-assets.mjs), so they cannot exist at
  // build time and must resolve against the module URL at runtime.
  /* @vite-ignore */
  workerSrc: new URL("./pdf.worker.min.mjs", import.meta.url).href,
  /* @vite-ignore */
  cMapUrl: new URL("./pdfcmaps/", import.meta.url).href,
  /* @vite-ignore */
  standardFontDataUrl: new URL("./pdffonts/", import.meta.url).href,
  // Refuse the CDN fallback outright rather than "working" only when online.
  webFallbackScripts: "never",
  cMapPacked: true,
} as const;

/** Built once: `plugins` and `toolbar` are part of the React wrapper's effect
 *  dependencies, so a fresh literal every render would destroy and rebuild the
 *  viewer on each keystroke. */
const VIEWER_PLUGINS = [
  imagePlugin(),
  textPlugin(),
  pdfPlugin(PDF_ASSETS),
  audioPlugin(),
  videoPlugin(),
  archivePlugin(),
  officePlugin(),
];

/** No download button: the file is already local, and a download would need an
 *  object URL for bytes this plugin is deliberately not keeping around. */
const VIEWER_TOOLBAR = {
  zoom: true,
  search: true,
  rotate: false,
  download: false,
  fullscreen: true,
  print: false,
} as const;

/** The zone keeps one height in both modes, so switching does not move the
 *  panels under it (same geometric rule as every other floating panel). */
const ZONE_HEIGHT = 260;

// ───────────────────────────── 插件自己的偏好 ─────────────────────────────

const PREFS_KEY = "fm.preview.prefs.v1";
const LEGACY_KEY = "fm.preview-text.prefs.v1";
const MIN_CHARS = 1_000;
const MAX_CHARS_LIMIT = 2_000_000;
const FITS = ["contain", "width", "actual"] as const;
type Fit = (typeof FITS)[number];

interface Prefs {
  /** 文本类内容最多显示多少字符，超出即截断。 */
  maxTextChars: number;
  /** 图片/PDF 的默认适配方式。 */
  defaultFit: Fit;
}

const DEFAULT_PREFS: Prefs = { maxTextChars: 200_000, defaultFit: "contain" };

const clampChars = (n: number): number =>
  Math.min(MAX_CHARS_LIMIT, Math.max(MIN_CHARS, Math.round(Number.isFinite(n) ? n : DEFAULT_PREFS.maxTextChars)));

/** The legacy text-preview page only ever had two options, and only one of them
 *  survives here: `autoLoad` must NOT become "auto preview" — the new default is
 *  explicitly the thumbnail. Read once, then the old key is dropped (no double
 *  write). */
function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const parsed = { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) };
      return {
        maxTextChars: clampChars(parsed.maxTextChars),
        defaultFit: FITS.includes(parsed.defaultFit) ? parsed.defaultFit : DEFAULT_PREFS.defaultFit,
      };
    }
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const old = JSON.parse(legacy) as { maxChars?: number };
      localStorage.removeItem(LEGACY_KEY);
      const migrated: Prefs = {
        ...DEFAULT_PREFS,
        maxTextChars: clampChars(old.maxChars ?? DEFAULT_PREFS.maxTextChars),
      };
      localStorage.setItem(PREFS_KEY, JSON.stringify(migrated));
      return migrated;
    }
  } catch {
    // a broken preference falls back rather than refusing to render
  }
  return DEFAULT_PREFS;
}

let prefs: Prefs = readPrefs();
const prefsListeners = new Set<() => void>();

function patchPrefs(patch: Partial<Prefs>): void {
  prefs = {
    ...prefs,
    ...patch,
    ...(patch.maxTextChars === undefined ? {} : { maxTextChars: clampChars(patch.maxTextChars) }),
  };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // storage unavailable: the preference still applies for this session
  }
  for (const listener of prefsListeners) listener();
}

function usePrefs(): Prefs {
  return useSyncExternalStore(
    (cb) => {
      prefsListeners.add(cb);
      return () => {
        prefsListeners.delete(cb);
      };
    },
    () => prefs,
  );
}

/** 通道或 `fs.readText` 回的错误先按线协议前缀定性，再看内容签名：路径本身可能
 *  就叫"损坏文件"，所以前缀判断必须在关键词判断之前。 */
function channelFailureState(text: string): Phase {
  if (text.startsWith("not found:")) return "not-found";
  if (text.startsWith("permission denied:")) return "permission-denied";
  if (text.startsWith("invalid argument:")) return "unsupported";
  return readFailureState(text);
}

/** 一次字节读取的三种收场：拼好的正文、太大、或者用户已经走了。 */
type Loaded = { blob: Blob } | { tooLargeBytes: number } | null;

// ─────────────────────────────── 预览区本体 ───────────────────────────────

/** The focus this zone previews: a file reference, or nothing. Folders are the
 *  directory browser's business, never a "document" here. */
function focusFileRef(s: HostMetaState): Ref | null {
  return s.focusRef?.kind === "file" ? s.focusRef : null;
}

export function PreviewPanel({ host }: SlotProps) {
  const { maxTextChars, defaultFit } = usePrefs();
  const [focus, setFocus] = useState<Ref | null>(() => focusFileRef(host.getState()));
  const path = focus?.id ?? null;
  const [mode, setMode] = useState<Mode>("thumbnail");
  const [phase, setPhase] = useState<Phase>("idle");
  const [detail, setDetail] = useState<string | null>(null);
  /** 通道或查看器给出的原始原因（英文、带线协议前缀）。它只进 `title`，不进正文：
   *  界面必须全中文，但排查时得能看到真实原因。 */
  const [raw, setRaw] = useState<string | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [extension, setExtension] = useState("");
  const [file, setFile] = useState<Blob | null>(null);
  const [fileName, setFileName] = useState("");
  const [format, setFormat] = useState<FileKind | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  /** 文本类由宿主解码，编码名是给用户看的事实（P7-19），不是排查信息。 */
  const [encoding, setEncoding] = useState<string | null>(null);

  /** Every await checks this: a response for a file the user has already left is
   *  discarded, never painted. */
  const seqRef = useRef(0);
  /** The live handle, so leaving the viewer can revoke it even mid-read. */
  const handleRef = useRef<string | null>(null);

  useEffect(() => host.onStateChange((s) => setFocus(focusFileRef(s))), [host]);

  /** One emitter for the whole zone: mode, state, format and progress leave this
   *  component together, so no code path can update one and forget the others.
   *  The payload carries the opaque ref — never bytes, never a Blob. */
  useEffect(() => {
    const args: PreviewStateChangedArgs = {
      ref: focus,
      mode,
      state: phase,
      format,
      progress,
    };
    host.emit(Events.previewStateChanged, args);
  }, [host, focus, mode, phase, format, progress]);

  /** A new focus means a new everything: back to 缩略图, drop the old bytes and
   *  the old handle. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: 焦点换文件即整板重置——seq 递增让旧文件的迟到响应失效，并回缩略图
  useEffect(() => {
    seqRef.current += 1;
    setMode("thumbnail");
    setPhase("idle");
    setDetail(null);
    setRaw(null);
    setFile(null);
    setDataUrl(null);
    setExtension("");
    setFormat(null);
    setProgress(null);
    setEncoding(null);
    const stale = handleRef.current;
    handleRef.current = null;
    if (stale) void host.invoke<boolean>(Capabilities.fsCloseResource, { handle: stale }).catch(() => false);
  }, [host, path]);

  // 缩略图模式：只问系统要一张图，正文一个字节都不读。
  useEffect(() => {
    if (!path || mode !== "thumbnail") return;
    const seq = seqRef.current;
    let active = true;
    host
      .invoke<FileKindOut>(Capabilities.fileKind, { path, isDir: false })
      .then((kind) => {
        if (active && seqRef.current === seq) setExtension(kind.extension);
      })
      .catch(() => undefined);
    host
      .invoke<ShellThumbnailOut>(Capabilities.shellThumbnailRead, { path, edge: THUMB_EDGE })
      .then((out) => {
        if (!active || seqRef.current !== seq) return;
        setDataUrl(out?.state === "ready" ? out.dataUrl : null);
      })
      .catch(() => {
        if (active && seqRef.current === seq) setDataUrl(null);
      });
    // Teardown here is *not* a cancel of the preview channel: switching to 文件预览
    // unmounts this effect too, and bumping the sequence would invalidate the read
    // that click just started. The picture is decoration — dropping it locally is
    // enough, and a focus change already bumps the sequence elsewhere.
    return () => {
      active = false;
    };
  }, [host, path, mode]);

  const release = useCallback(async (): Promise<void> => {
    const handle = handleRef.current;
    handleRef.current = null;
    if (!handle) return;
    await host.invoke<boolean>(Capabilities.fsCloseResource, { handle }).catch(() => false);
  }, [host]);

  /** A failure *inside* the viewer is still this zone's state to report: an
   *  encrypted, damaged or unreadable file each get their own Chinese state and a
   *  way out, instead of a blank panel with the viewer's own text on it. */
  const onViewerError = useCallback((err: Error): void => {
    const text = errorMessage(err);
    setRaw(text);
    setDetail(null);
    setPhase(readFailureState(text, err));
  }, []);

  const onUnsupportedFile = useCallback((): void => {
    setPhase("unsupported");
    setDetail("查看器里没有支持这个格式的组件。");
  }, []);

  /** The viewer's own failure card, turned back into one of this zone's states:
   *  the card text is the real reason and goes to `title`, the user gets the
   *  Chinese state copy, and the viewer node goes away with it. */
  const onViewerFallback = useCallback((text: string, encrypted: boolean): void => {
    if (text === "") return;
    setRaw(text);
    setDetail(null);
    setPhase(encrypted ? "password-required" : readFailureState(text));
  }, []);

  /** Pull the whole (bounded) file through the chunk channel. Returns `null` when
   *  the answer arrived after the user moved on. */
  const loadBytes = useCallback(
    async (target: string, seq: number): Promise<Loaded> => {
      const opened = await host.invoke<ResourceOut>(Capabilities.fsOpenResource, { path: target });
      if (seqRef.current !== seq) {
        // Nobody is waiting for this preview any more; do not keep its handle.
        void host.invoke<boolean>(Capabilities.fsCloseResource, { handle: opened.handle }).catch(() => false);
        return null;
      }
      handleRef.current = opened.handle;
      if (opened.byteLength > MAX_PREVIEW_BYTES) {
        await release();
        return { tooLargeBytes: opened.byteLength };
      }
      const parts: Uint8Array[] = [];
      let offset = 0;
      while (offset < opened.byteLength) {
        const chunk = await host.invoke<ReadResourceOut>(Capabilities.fsReadResource, {
          handle: opened.handle,
          offset,
          length: MAX_RESOURCE_CHUNK_BYTES,
          requestToken: `p${seq}`,
        });
        if (seqRef.current !== seq || chunk.requestToken !== `p${seq}`) {
          await release();
          return null;
        }
        const bytes = decodeResourceChunk(chunk.data);
        if (bytes.length === 0) break;
        parts.push(bytes);
        offset += bytes.length;
        setProgress(Math.min(1, offset / Math.max(1, chunk.total)));
        if (chunk.eof) break;
      }
      await release();
      if (seqRef.current !== seq) return null;
      setProgress(null);
      const type = opened.mime ?? "application/octet-stream";
      return { blob: new Blob(parts as BlobPart[], { type }) };
    },
    [host, release],
  );

  /** 文本类经宿主的 `fs.readText`：编码是 chardetng 猜的、正文是 encoding_rs 解的，
   *  查看器只会被喂一份 UTF-8 正文。超限与二进制在这里就变成两种可区分的中文状态。 */
  const loadText = useCallback(
    async (target: string, mime: string | null, seq: number): Promise<void> => {
      let out: ReadTextOut;
      try {
        out = await host.invoke<ReadTextOut>(Capabilities.fsReadText, { path: target });
      } catch (err) {
        if (seqRef.current !== seq) return;
        const text = errorMessage(err);
        setPhase(channelFailureState(text));
        setRaw(text);
        return;
      }
      if (seqRef.current !== seq) return;
      if (out.state === "too-large") {
        setPhase("too-large");
        setDetail(`文本预览上限 ${formatSize(MAX_TEXT_READ_BYTES)}，这个文件 ${formatSize(out.byteLength)}。`);
        return;
      }
      if (out.state === "binary" || out.text === null) {
        setPhase("unsupported");
        setDetail(`这不是文本文件（${formatSize(out.byteLength)}），无法按文本预览。`);
        return;
      }
      setEncoding(`编码 ${out.encoding ?? "UTF-8"} · ${formatSize(out.byteLength)}`);
      setFileName(nameOf(target));
      setFile(new Blob([out.text], { type: mime ?? "text/plain" }));
      setPhase("ready");
    },
    [host],
  );

  const openViewer = useCallback(async (): Promise<void> => {
    if (!path) return;
    const seq = seqRef.current;
    setDetail(null);
    setRaw(null);
    setProgress(null);
    setEncoding(null);
    setPhase("checking");
    let kind: FileKindOut;
    try {
      kind = await host.invoke<FileKindOut>(Capabilities.fileKind, { path, isDir: false });
    } catch (err) {
      if (seqRef.current !== seq) return;
      setPhase("error");
      setRaw(errorMessage(err));
      return;
    }
    if (seqRef.current !== seq) return;
    setFormat(kind.kind);
    if (!VIEWABLE_KINDS.has(kind.kind)) {
      setPhase("unsupported");
      setDetail(
        `${KIND_LABELS[kind.kind] ?? kind.kind}${kind.extension ? `（.${kind.extension}）` : "（无扩展名）"}不在本应用查看器支持的格式内。`,
      );
      return;
    }
    setPhase("loading");
    if (TEXTUAL_KINDS.has(kind.kind)) {
      await loadText(path, kind.mime, seq);
      return;
    }
    try {
      const loaded = await loadBytes(path, seq);
      if (loaded === null) return;
      if ("tooLargeBytes" in loaded) {
        setPhase("too-large");
        setDetail(`这个文件 ${formatSize(loaded.tooLargeBytes)}，超过预览上限 ${formatSize(MAX_PREVIEW_BYTES)}。`);
        return;
      }
      setFileName(nameOf(path));
      setFile(loaded.blob);
      setPhase("ready");
    } catch (err) {
      if (seqRef.current !== seq) return;
      const text = errorMessage(err);
      // 线协议前缀是给程序看的，界面只留中文状态文案；原文进 title 备排查。
      setPhase(channelFailureState(text));
      setRaw(text);
    }
  }, [host, loadBytes, loadText, path]);

  const backToThumbnail = useCallback((): void => {
    const wasReading = phase === "checking" || phase === "loading";
    seqRef.current += 1;
    setMode("thumbnail");
    // A read the user walked away from is reported as cancelled, not as if it had
    // never been asked for; a completed preview just goes back to the picture.
    setPhase(wasReading ? "cancelled" : "idle");
    setDetail(null);
    setRaw(null);
    setFile(null);
    setProgress(null);
    setEncoding(null);
    void release();
  }, [phase, release]);

  // Unmount / plugin deactivation: the handle must not outlive the panel.
  useEffect(
    () => () => {
      seqRef.current += 1;
      const handle = handleRef.current;
      handleRef.current = null;
      if (handle) void host.invoke<boolean>(Capabilities.fsCloseResource, { handle }).catch(() => false);
    },
    [host],
  );

  const openWithShell = useCallback((): void => {
    if (!path) return;
    host.invoke<boolean>(Capabilities.shellOpenPath, { path }).catch((err) => {
      setPhase("error");
      setDetail("用 Windows 打开失败了。");
      setRaw(errorMessage(err));
    });
  }, [host, path]);

  if (!path) {
    return (
      <Stack className="fm-detail-block" gap="xs" data-testid="preview-empty">
        <Text size="xs" fw={600}>
          预览
        </Text>
        <Text size="xs" c="dimmed">
          选中一个文件后可预览。
        </Text>
      </Stack>
    );
  }

  return (
    <Stack className="fm-detail-block fm-preview-block" gap={8}>
      <Group gap={6} wrap="nowrap" justify="space-between">
        <Text size="xs" fw={600}>
          预览
        </Text>
        <Button
          size="compact-xs"
          variant="light"
          color={mode === "viewer" ? "blue" : "gray"}
          onClick={() => {
            if (mode === "viewer") {
              backToThumbnail();
              return;
            }
            // The click itself switches the zone; the read only ever starts here.
            setMode("viewer");
            void openViewer();
          }}
          data-testid="preview-toggle"
          aria-pressed={mode === "viewer"}
        >
          {mode === "viewer" ? "返回缩略图" : "打开文件预览"}
        </Button>
      </Group>

      <div style={{ height: ZONE_HEIGHT, overflow: "hidden" }} data-testid={`preview-mode-${mode}`}>
        {mode === "thumbnail" ? (
          <Stack gap={6} align="center" justify="center" style={thumbBoxStyle}>
            {dataUrl ? (
              <img src={dataUrl} alt="" style={thumbImageStyle} data-testid="preview-thumb" />
            ) : (
              <Badge size="lg" variant="light" color="gray" data-testid="preview-thumb-fallback">
                {extension ? `.${extension}` : "文件"}
              </Badge>
            )}
            <Text size="xs" c="dimmed" ta="center" style={{ wordBreak: "break-all" }}>
              {nameOf(path)}
            </Text>
            {phase === "cancelled" ? (
              <Text size="xs" c="dimmed" data-testid="preview-cancelled-note">
                已取消上一次的内容读取，现在只显示系统缩略图。
              </Text>
            ) : null}
          </Stack>
        ) : (
          <ViewerBody
            phase={phase}
            detail={detail}
            raw={raw}
            progress={progress}
            file={file}
            fileName={fileName}
            encoding={encoding}
            fit={defaultFit}
            maxTextChars={maxTextChars}
            onOpenWithShell={openWithShell}
            onRetry={() => void openViewer()}
            onViewerError={onViewerError}
            onViewerFallback={onViewerFallback}
            onUnsupportedFile={onUnsupportedFile}
          />
        )}
      </div>
    </Stack>
  );
}

/** A viewer that cannot parse the bytes still has to say *why* in one of the
 *  spec's states: an encrypted document, a damaged one, and a plain read failure
 *  are three different things for the user. The classification is on the error
 *  pdf.js / jszip / the browser media element actually raise, and on the wording
 *  of the card Open File Viewer paints when it fails without calling `onError` —
 *  which is why the Chinese half of the signatures is in here too. */
function readFailureState(text: string, err?: Error): Phase {
  const signature = `${err?.name ?? ""} ${text}`.toLowerCase();
  if (/password|encrypted|encrypt|加密|密码/.test(signature)) return "password-required";
  if (
    err?.name === "InvalidPDFException" ||
    /invalid pdf|missing startxref|bad xref|corrupt|unexpected file|can.t open|not a valid|signature|损坏|格式无效|无法解析|解析失败|预览失败/.test(
      signature,
    )
  ) {
    return "corrupt";
  }
  if (/unsupported|不支持|需要服务端|convert/.test(signature)) return "unsupported";
  if (text.startsWith("not found:")) return "not-found";
  if (text.startsWith("permission denied:")) return "permission-denied";
  return "error";
}

function ViewerBody({
  phase,
  detail,
  raw,
  progress,
  file,
  fileName,
  encoding,
  fit,
  maxTextChars,
  onOpenWithShell,
  onRetry,
  onViewerError,
  onViewerFallback,
  onUnsupportedFile,
}: {
  phase: Phase;
  detail: string | null;
  raw: string | null;
  progress: number | null;
  file: Blob | null;
  fileName: string;
  encoding: string | null;
  fit: Fit;
  maxTextChars: number;
  onOpenWithShell: () => void;
  onRetry: () => void;
  onViewerError: (err: Error) => void;
  onViewerFallback: (text: string, encrypted: boolean) => void;
  onUnsupportedFile: () => void;
}): React.JSX.Element {
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Open File Viewer renders a document it cannot parse as its own card *inside*
  // the viewport and reports nothing through `onError`, so "the viewer is up"
  // would otherwise be a false `ready`. The card is the library's own
  // `.ofv-fallback` node; watching it keeps this zone the single owner of state.
  useEffect(() => {
    if (phase !== "ready") return;
    const root = bodyRef.current;
    if (!root) return;
    const report = (): void => {
      const card = root.querySelector<HTMLElement>(".ofv-fallback");
      if (!card) return;
      onViewerFallback(card.textContent?.trim() ?? "", card.classList.contains("ofv-encrypted"));
    };
    report();
    const observer = new MutationObserver(report);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [phase, onViewerFallback]);

  if (phase !== "ready" || !file) {
    const copy =
      phase === "loading" && progress !== null
        ? `${PHASE_TEXT[phase]}已读取 ${Math.round(progress * 100)}%`
        : PHASE_TEXT[phase];
    return (
      <Stack gap={8} align="flex-start" data-testid="preview-state">
        <Text
          size="xs"
          c={FAILING.has(phase) ? "red" : "dimmed"}
          data-testid="preview-state-text"
          title={raw ?? undefined}
        >
          {copy}
        </Text>
        {detail && (
          <Text size="xs" c="dimmed" style={{ wordBreak: "break-all" }} data-testid="preview-error">
            {detail}
          </Text>
        )}
        {SYSTEM_OPEN_STATES.has(phase) ? (
          <Button
            size="compact-xs"
            variant="light"
            color="gray"
            onClick={onOpenWithShell}
            data-testid="preview-open-system"
          >
            用 Windows 打开
          </Button>
        ) : null}
        {RETRYABLE.has(phase) ? (
          <Button size="compact-xs" variant="light" color="gray" onClick={onRetry} data-testid="preview-retry">
            重试
          </Button>
        ) : null}
      </Stack>
    );
  }
  return (
    <div ref={bodyRef} data-testid="preview-viewer" style={{ height: "100%" }}>
      {encoding ? (
        <Text size="xs" c="dimmed" data-testid="preview-encoding" style={{ marginBottom: 2 }}>
          {encoding}
        </Text>
      ) : null}
      <div style={{ height: encoding ? "calc(100% - 22px)" : "100%" }}>
        <FileViewer
          file={truncatedText(file, maxTextChars)}
          fileName={fileName}
          mimeType={file.type || undefined}
          height="100%"
          fit={fit}
          plugins={VIEWER_PLUGINS}
          toolbar={VIEWER_TOOLBAR}
          locale="zh-CN"
          fallback="inline"
          onError={onViewerError}
          onUnsupported={onUnsupportedFile}
        />
      </div>
    </div>
  );
}

/** Which states paint red, which offer 用 Windows 打开, and which offer 重试.
 *  Kept as sets so a new state cannot be added to the union and forgotten here. */
const FAILING: ReadonlySet<Phase> = new Set<Phase>([
  "permission-denied",
  "not-found",
  "corrupt",
  "password-required",
  "error",
]);
const SYSTEM_OPEN_STATES: ReadonlySet<Phase> = new Set<Phase>([
  "unsupported",
  "too-large",
  "corrupt",
  "password-required",
]);
const RETRYABLE: ReadonlySet<Phase> = new Set<Phase>(["not-found", "permission-denied", "corrupt", "error"]);

/** Text is shown through the viewer, but a 60 MB log is not a document to scroll:
 *  the preference truncates it before the viewer ever parses it. */
function truncatedText(file: Blob, maxChars: number): Blob {
  if (!file.type.startsWith("text/")) return file;
  if (file.size <= maxChars) return file;
  return file.slice(0, maxChars);
}

const PHASE_TEXT: Record<Phase, string> = {
  idle: "尚未读取内容。",
  checking: "正在判断这个类型能否预览…",
  loading: "正在读取内容…",
  ready: "",
  unsupported: "这个格式本应用暂不支持预览。",
  "too-large": "文件太大，不读取全文，可先用系统打开。",
  "not-found": "文件已不存在，可能刚被移动或删除。",
  "permission-denied": "没有权限读取这个文件。",
  corrupt: "文件内容损坏，查看器无法解析。",
  "password-required": "这个文件受密码或加密保护，需要先输入密码。本应用不代填密码，可用 Windows 打开。",
  cancelled: "已取消这次内容读取。",
  error: "读取失败。",
};

const thumbBoxStyle: CSSProperties = { height: "100%", justifyContent: "center" };
const thumbImageStyle: CSSProperties = {
  maxWidth: "100%",
  maxHeight: ZONE_HEIGHT - 40,
  objectFit: "contain",
};

/** 本插件在设置面板里的那一页：只存格式偏好，不存预览模式。 */
export function SettingsPage() {
  const current = usePrefs();
  return (
    <Stack gap="md">
      <div>
        <Text size="sm" fw={600}>
          文本显示字符上限
        </Text>
        <Text size="xs" c="dimmed" mb={6}>
          超出部分不交给查看器解析。范围 1 千 ~ {MAX_CHARS_LIMIT.toLocaleString("zh-CN")}。
        </Text>
        <TextInput
          size="xs"
          w={170}
          inputMode="numeric"
          value={String(current.maxTextChars)}
          onChange={(e) => {
            const n = Number.parseInt(e.currentTarget.value, 10);
            if (Number.isFinite(n)) patchPrefs({ maxTextChars: n });
          }}
        />
      </div>
      <div>
        <Text size="sm" fw={600}>
          默认适配方式
        </Text>
        <Text size="xs" c="dimmed" mb={6}>
          图片与 PDF 打开时的显示方式。每个新选中的文件仍默认停留在缩略图，不会自动预览。
        </Text>
        <NativeSelect
          size="xs"
          w={170}
          data={[
            { value: "contain", label: "适合窗口" },
            { value: "width", label: "按宽度" },
            { value: "actual", label: "原始尺寸" },
          ]}
          value={current.defaultFit}
          onChange={(e) => patchPrefs({ defaultFit: e.currentTarget.value as Fit })}
        />
      </div>
    </Stack>
  );
}
