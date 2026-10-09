/**
 * `plugin-preview-text` — content plugin for the D 信息页's `preview-zone`
 * (roadmap P6-57, docs/08 §5).
 *
 * It follows the cascade's opaque `focusRef` (read through `host.getState()` /
 * `onStateChange`, never through an event it has to be granted) and asks only for
 * `fs.readText`. Everything it shows is what the base already decided to focus —
 * this plugin owns no state the base could need (docs/01 §6 red line 2).
 *
 * The zone is one of the fixed slots `plugin-inspector` provides inside 信息, so a
 * second content plugin can sit next to the property table without either knowing
 * about the other.
 *
 * How much it reads and whether it reads on its own is the plugin's OWN preference
 * (`fm.preview-text.prefs.v1`), editable through the page it contributes to
 * `plugin-settings`' floating panel.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import {
  Button,
  Code,
  Group,
  NumberInput,
  ScrollArea,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import { errorMessage, type HostMetaState, type SlotProps } from "@my-file-manager/plugin-sdk";

/** Only a `file` reference has text to show; folders and unknown kinds opt out. */
function focusedFile(s: HostMetaState): string | null {
  return s.focusRef?.kind === "file" ? s.focusRef.id : null;
}

// ───────────────────────────── 插件自己的偏好 ─────────────────────────────

const PREFS_KEY = "fm.preview-text.prefs.v1";
const MIN_CHARS = 1_000;
const MAX_CHARS_LIMIT = 2_000_000;

interface Prefs {
  /** 选中文件就自动读，还是要用户点一下。大文件多时关掉能省掉每次点击的一次读盘。 */
  autoLoad: boolean;
  /** 读进来之后最多显示多少字符，超出即截断。 */
  maxChars: number;
}

const DEFAULT_PREFS: Prefs = { autoLoad: true, maxChars: 200_000 };

const clampChars = (n: number): number =>
  Math.min(MAX_CHARS_LIMIT, Math.max(MIN_CHARS, Math.round(Number.isFinite(n) ? n : DEFAULT_PREFS.maxChars)));

function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) };
    return { ...parsed, maxChars: clampChars(parsed.maxChars) };
  } catch {
    return DEFAULT_PREFS;
  }
}

let prefs: Prefs = readPrefs();
const prefsListeners = new Set<() => void>();

function patchPrefs(patch: Partial<Prefs>): void {
  prefs = {
    ...prefs,
    ...patch,
    ...(patch.maxChars === undefined ? {} : { maxChars: clampChars(patch.maxChars) }),
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

export function TextPreview({ host }: SlotProps) {
  const { autoLoad, maxChars } = usePrefs();
  const [path, setPath] = useState<string | null>(() => focusedFile(host.getState()));
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (target: string | null): Promise<void> => {
      setText(null);
      setError(null);
      if (!target) return;
      try {
        const content = await host.invoke<string>("fs.readText", { path: target });
        setText(String(content));
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [host],
  );

  useEffect(() => host.onStateChange((s) => setPath(focusedFile(s))), [host]);

  // 焦点或偏好一变就重来：自动读取关掉时只清空，等按钮。
  useEffect(() => {
    if (!path || !autoLoad) {
      setText(null);
      setError(null);
      return;
    }
    void load(path);
  }, [path, autoLoad, load]);

  if (!path) {
    return (
      <Stack className="fm-detail-block" gap="xs">
        <Group gap={6}>
          <Text size="xs" fw={600}>
            预览
          </Text>
        </Group>
        <Text size="xs" c="dimmed">
          选中一个文件后可预览其文本内容。
        </Text>
      </Stack>
    );
  }

  return (
    <Stack className="fm-detail-block fm-preview-block" gap={8}>
      <Group gap={6} wrap="nowrap">
        <Text size="xs" fw={600}>
          预览
        </Text>
        {!autoLoad && (
          <Button size="compact-xs" variant="light" color="gray" onClick={() => void load(path)}>
            读取内容
          </Button>
        )}
      </Group>
      {error ? (
        <Text size="xs" c="red" style={{ wordBreak: "break-all" }}>
          {error}
        </Text>
      ) : (
        <ScrollArea styles={{ viewport: { maxHeight: 220 } }}>
          <Code block style={{ fontSize: 12, lineHeight: 1.7, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {text === null ? (autoLoad ? "载入中…" : "尚未读取") : truncate(text, maxChars)}
          </Code>
        </ScrollArea>
      )}
    </Stack>
  );
}

/** A file manager preview is not a pager: past the limit the rest is not read into
 *  the sidebar. */
function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（已截断）` : text;
}

/** 本插件在设置面板里的那一页：两个只影响自己的开关，内容与其他插件无关。 */
export function SettingsPage() {
  const current = usePrefs();
  return (
    <Stack gap="md">
      <Group gap={10} wrap="nowrap">
        <div style={prefTextStyle}>
          <Text size="sm" fw={600}>
            自动读取
          </Text>
          <Text size="xs" c="dimmed">
            关闭后选中文件不再立刻读盘，显示「读取内容」按钮，点一下才预览。
          </Text>
        </div>
        <Switch
          size="xs"
          checked={current.autoLoad}
          aria-label="自动读取文本内容"
          onChange={(e) => patchPrefs({ autoLoad: e.currentTarget.checked })}
        />
      </Group>
      <div>
        <Text size="sm" fw={600}>
          显示字符上限
        </Text>
        <Text size="xs" c="dimmed" mb={6}>
          超出的部分不显示。范围 1 千 ~ {MAX_CHARS_LIMIT.toLocaleString("zh-CN")}。
        </Text>
        <NumberInput
          size="xs"
          w={170}
          hideControls
          decimalScale={0}
          min={MIN_CHARS}
          max={MAX_CHARS_LIMIT}
          value={current.maxChars}
          onChange={(v) => patchPrefs({ maxChars: Number(v) || current.maxChars })}
        />
      </div>
    </Stack>
  );
}

const prefTextStyle: CSSProperties = { flex: 1, minWidth: 0 };
