/**
 * `plugin-settings` — 设置入口 + 悬浮设置面板（docs/08 §5）。
 *
 * 它向 A 栏底部贡献一个齿轮，点击后在**界面之上**开一个非模态浮层（Mantine
 * `Popover`：portal 到 body、自动翻转避让、点外部/ESC 关闭），而不是占用 B 侧栏
 * 的一个视图。浮层内是分页：**软件设置**（外观 + 插件启停）与**插件设置**。
 *
 * 插件设置页由各插件自己贡献：本插件提供嵌套槽前缀 `settings-page`，谁贡献了
 * `settings-page:<名字>` 就出现一个二级 tab，标题取贡献者自己声明的 `label`
 * （`host.slotLabel`），内容完全由贡献者决定——本文件不读任何他插件的数据，
 * 也不知道里面是什么（docs/02 §4.5/§8）。所有页面保持挂载、只隐藏非活动者，
 * 与 `plugin-inspector` 的 tab 同一条规则。
 *
 * 启停能力不在这里自造：`plugins.list` / `plugins.setEnabled` 是**基座 loader
 * 持有的运行态**（含持久化与核心插件保护），这里只是经过自己 manifest
 * `permissions.capabilities` 白名单去调用它（docs/01 §6 red line 2）。
 * 主题则完全交给 Mantine（`useMantineColorScheme`）：与基座顶栏读写同一个值。
 *
 * 面板尺寸是**固定**的（`PANEL_WIDTH × PANEL_HEIGHT`）：分页内容高低不同，若让
 * 浮层自适应，每次切换都会重算高度并让 floating-ui 重新定位 → 面板既变形又挪位。
 * 因此外层与内层 tab 条固定不缩，正文区自己出滚动条。
 */
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  ActionIcon,
  Badge,
  Group,
  Popover,
  SegmentedControl,
  Stack,
  Switch,
  Tabs,
  Text,
  Title,
  useMantineColorScheme,
} from "@mantine/core";
import { Monitor, Moon, Settings, Sun, X } from "lucide-react";
import {
  FrontendCapabilities,
  errorMessage,
  type PluginInfo,
  type PluginSetEnabledArgs,
  type SlotProps,
} from "@my-file-manager/plugin-sdk";

/** 各插件贡献自己设置页的嵌套槽前缀（本插件在 manifest `frontend.provides` 里声明）。 */
const SETTINGS_PREFIX = "settings-page";
const PAGE_PREFIX_LEN = `${SETTINGS_PREFIX}:`.length;

/** 面板固定尺寸：变分页/变子页都不改它，只有正文区滚动。 */
const PANEL_WIDTH = 620;
const PANEL_HEIGHT = 560;

type Section = "app" | "plugins";
type Scheme = "auto" | "light" | "dark";

export function SettingsEntry({ host }: SlotProps) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<Section>("app");
  const [page, setPage] = useState<string | null>(null);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [, bump] = useState(0);

  // 插件被停用/启用时它的设置页贡献会消失或出现，tab 条要跟着重算。
  useEffect(() => host.onSlotsChange(() => bump((n) => n + 1)), [host]);

  const refresh = useCallback((): void => {
    host
      .invoke<PluginInfo[]>(FrontendCapabilities.pluginsList)
      .then(setPlugins)
      .catch((err) => setNotice(errorMessage(err)));
  }, [host]);

  useEffect(() => {
    if (!open) return;
    setNotice(null);
    refresh();
  }, [open, refresh]);

  const toggle = (name: string, enabled: boolean): void => {
    setNotice(null);
    host
      .invoke<PluginInfo[]>(
        FrontendCapabilities.pluginsSetEnabled,
        { name, enabled } satisfies PluginSetEnabledArgs,
      )
      .then(setPlugins)
      .catch((err) => setNotice(errorMessage(err)));
  };

  const pages = host.contributedSlots(SETTINGS_PREFIX);
  const activePage = page && pages.includes(page) ? page : pages[0];

  return (
    <Popover
      opened={open}
      onChange={setOpen}
      position="right-start"
      offset={10}
      withArrow
      arrowPosition="center"
      width={PANEL_WIDTH}
      shadow="md"
      middlewares={{ flip: true, shift: { padding: 8, crossAxis: true } }}
      styles={{ dropdown: dropdownStyle }}
    >
      <Popover.Target>
        {/* `opened` 走受控模式时 Mantine 的 `Popover.Target` 不再自己挂 onClick（源码
            `...!ctx.controlled ? { onClick: ctx.onToggle } : null`），开合必须由这里
            自己翻；`onChange` 仍负责 ESC / 点外部把状态送回来。 */}
        <button
          type="button"
          className="fm-rail-button"
          aria-pressed={open}
          title="设置"
          aria-label="设置"
          onClick={() => setOpen((o) => !o)}
          style={railButtonStyle(open)}
        >
          <Settings size={17} />
        </button>
      </Popover.Target>

      <Popover.Dropdown className="fm-settings">
        <Group className="fm-settings-header" gap={8} wrap="nowrap" style={panelHeaderStyle}>
          <Title order={6} tt="none">
            设置
          </Title>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            title="关闭设置"
            aria-label="关闭设置"
            style={{ marginLeft: "auto" }}
            onClick={() => setOpen(false)}
          >
            <X size={14} />
          </ActionIcon>
        </Group>

        <Tabs
          value={section}
          onChange={(v) => setSection((v as Section) ?? "app")}
          variant="pills"
          styles={{ tab: sectionTabStyle }}
          style={{ flexShrink: 0 }}
        >
          <Tabs.List>
            <Tabs.Tab value="app">软件设置</Tabs.Tab>
            <Tabs.Tab value="plugins">插件设置</Tabs.Tab>
          </Tabs.List>
        </Tabs>

        {/* 分页体：固定占满剩余高度，正文超出就在**这里**滚动。与 plugin-inspector
            同一做法——外层 Tabs 只画 tab 条，正文按活动页显示/隐藏，切换不会卸载
            另一页的插件组件。 */}
        <div style={bodyStyle}>
          <div style={sectionStyle(section === "app")}>
            <SoftwareSettings plugins={plugins} notice={notice} onToggle={toggle} />
          </div>
          <div style={sectionStyle(section === "plugins")}>
            <PluginPages
              host={host}
              pages={pages}
              active={activePage}
              onSelect={(id) => setPage(id)}
            />
          </div>
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}

/** 软件设置：基座自己的外观 + 插件开关。 */
function SoftwareSettings({
  plugins,
  notice,
  onToggle,
}: {
  plugins: PluginInfo[];
  notice: string | null;
  onToggle: (name: string, enabled: boolean) => void;
}) {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  return (
    <Stack gap="md">
      <Block title="外观">
        <SegmentedControl
          fullWidth
          size="xs"
          value={colorScheme}
          onChange={(v) => setColorScheme(v as Scheme)}
          data={[
            { value: "auto", label: <SchemeLabel icon={<Monitor size={12} />} text="跟随系统" /> },
            { value: "light", label: <SchemeLabel icon={<Sun size={12} />} text="亮色" /> },
            { value: "dark", label: <SchemeLabel icon={<Moon size={12} />} text="暗色" /> },
          ]}
        />
        <Text size="xs" c="dimmed">
          选择适合你的显示方式，自动保存并即时生效。
        </Text>
      </Block>

      <Block title="插件管理" hint="关闭即时生效：该插件贡献的界面立刻从界面上消失，重新开启即恢复。">
        {notice && (
          <Text size="xs" c="red">
            {notice}
          </Text>
        )}
        <Stack gap={4}>
          {plugins.map((info) => (
            <PluginRow key={info.name} info={info} onToggle={onToggle} />
          ))}
        </Stack>
      </Block>
    </Stack>
  );
}

function PluginRow({
  info,
  onToggle,
}: {
  info: PluginInfo;
  onToggle: (name: string, enabled: boolean) => void;
}) {
  return (
    <Group className="fm-plugin-row" gap={10} wrap="nowrap" style={rowStyle}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <Group gap={6} wrap="nowrap">
          <Text size="sm" fw={600} truncate>
            {info.displayName}
          </Text>
          {info.protected && (
            <Badge size="xs" variant="light" color="gray" title="基础插件保持开启，保证界面正常使用">
              基础插件
            </Badge>
          )}
        </Group>
        <Text size="xs" c="dimmed" truncate title={`${info.name} · v${info.version}`}>
          {info.description ?? info.name}
        </Text>
      </div>
      <Switch
        size="xs"
        checked={info.enabled}
        disabled={info.protected}
        aria-label={`启用${info.displayName}`}
        title={info.protected ? "基础插件不可关闭" : info.enabled ? "点击关闭该插件" : "点击开启该插件"}
        onChange={(e) => onToggle(info.name, e.currentTarget.checked)}
        style={{ flexShrink: 0 }}
      />
    </Group>
  );
}

/** 插件设置：tab 条来自 `settings-page:*` 的实际贡献者，页面全挂载。 */
function PluginPages({
  host,
  pages,
  active,
  onSelect,
}: {
  host: SlotProps["host"];
  pages: string[];
  active: string | undefined;
  onSelect: (slotId: string) => void;
}) {
  if (pages.length === 0) {
    return (
      <Text size="xs" c="dimmed" pt="md">
        已开启的插件都没有提供设置页。
      </Text>
    );
  }
  return (
    <>
      <Tabs
        value={active}
        onChange={(v) => v && onSelect(String(v))}
        variant="outline"
        styles={{ tab: pageTabStyle }}
        style={subTabsStyle}
      >
        <Tabs.List>
          {pages.map((slotId) => (
            <Tabs.Tab key={slotId} value={slotId} title={slotId}>
              {host.slotLabel(slotId) ?? slotId.slice(PAGE_PREFIX_LEN)}
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs>
      <div style={{ paddingTop: 10 }}>
        {pages.map((slotId) => (
          <div key={slotId} style={showHideStyle(slotId === active)}>
            <PageOutlet host={host} slotId={slotId} />
          </div>
        ))}
      </div>
    </>
  );
}

/** 一个 `settings-page:<名字>` 出口：内容由贡献该槽的插件自己渲染。 */
function PageOutlet({ host, slotId }: { host: SlotProps["host"]; slotId: string }) {
  const Outlet = host.provideSlot(slotId);
  return <Outlet id={slotId} />;
}

const SchemeLabel = ({ icon, text }: { icon: ReactNode; text: string }) => (
  <Group gap={4} wrap="nowrap">
    {icon}
    <span>{text}</span>
  </Group>
);

function Block({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Stack className="fm-settings-block" gap={10}>
      <Text size="xs" fw={600}>
        {title}
      </Text>
      {children}
      {hint && (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      )}
    </Stack>
  );
}

/** 分页体的显示/隐藏，**不卸载**：另一分页里插件组件的局部状态要留着（docs/02 §4.5）。
 *  React 会把值为 undefined 的行内样式属性删掉，所以两个分支都写全。
 *  活动页占满正文高度并自己滚动——面板外形因此与内容多少无关。 */
const sectionStyle = (active: boolean): CSSProperties =>
  active
    ? { display: "block", height: "100%", overflowY: "auto", overflowX: "hidden" }
    : { display: "none" };

/** 同一分页内的子页切换：只管显隐，滚动权在上面的分页体。 */
const showHideStyle = (active: boolean): CSSProperties =>
  active ? { display: "block" } : { display: "none" };

const railButtonStyle = (active: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 40,
  height: 40,
  margin: "2px auto",
  cursor: "pointer",
  borderRadius: "var(--mantine-radius-md)",
  border: "none",
  // 侧栏是 flex 列，齿轮靠 marginTop:auto 固定在底部。
  marginTop: "auto",
  background: active ? "var(--mantine-color-blue-light)" : "transparent",
  color: active ? "var(--mantine-color-blue-7)" : "var(--mantine-color-dimmed)",
});

const panelHeaderStyle: CSSProperties = { paddingBottom: 6, flexShrink: 0 };

const sectionTabStyle: CSSProperties = { fontSize: 12, padding: "4px 12px" };

const pageTabStyle: CSSProperties = { fontSize: 11, padding: "2px 8px" };

/** 正文区：吃掉剩余高度，滚动条只出现在这里的子页体内。 */
const bodyStyle: CSSProperties = { flex: 1, minHeight: 0, overflow: "hidden", paddingTop: 10 };

/** 子页 tab 条贴在滚动容器顶部，滚动时不跟着走。 */
const subTabsStyle: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  background: "var(--mantine-color-body)",
};

const dropdownStyle: CSSProperties = {
  // 外形固定：分页/子页内容高低不同也不重算尺寸，位置因此不会随切换跳动。
  width: PANEL_WIDTH,
  height: PANEL_HEIGHT,
  // 视口比面板还矮时只允许收缩，正常尺寸下不参与。
  maxWidth: "calc(100vw - 24px)",
  maxHeight: "calc(100vh - 24px)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  padding: 18,
};

const rowStyle: CSSProperties = {
  padding: "10px 12px",
  borderRadius: "var(--mantine-radius-sm)",
  border: "1px solid var(--mantine-color-default-border)",
};
