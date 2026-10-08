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
 */
import { useCallback, useEffect, useState } from "react";
import { Code, Group, ScrollArea, Stack, Text } from "@mantine/core";
import { errorMessage, type HostMetaState, type SlotProps } from "@my-file-manager/plugin-sdk";

/** Only a `file` reference has text to show; folders and unknown kinds opt out. */
function focusedFile(s: HostMetaState): string | null {
  return s.focusRef?.kind === "file" ? s.focusRef.id : null;
}

/** Enough for a glance; a file manager preview is not a pager, and reading a whole
 *  huge file into the sidebar would be the plugin's own bad idea. */
const MAX_CHARS = 200_000;

export function TextPreview({ host }: SlotProps) {
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

  useEffect(() => {
    const off = host.onStateChange((s) => {
      const next = focusedFile(s);
      setPath(next);
      void load(next);
    });
    void load(path);
    return off;
  }, [host, path, load]);

  if (!path) {
    return (
      <Stack gap="xs">
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
    <Stack gap={4}>
      <Text size="xs" fw={600}>
        预览
      </Text>
      {error ? (
        <Text size="xs" c="red" style={{ wordBreak: "break-all" }}>
          {error}
        </Text>
      ) : (
        <ScrollArea styles={{ viewport: { maxHeight: 220 } }}>
          <Code block style={{ fontSize: 11, whiteSpace: "pre-wrap" }}>
            {text === null ? "载入中…" : text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n…（已截断）` : text}
          </Code>
        </ScrollArea>
      )}
    </Stack>
  );
}
