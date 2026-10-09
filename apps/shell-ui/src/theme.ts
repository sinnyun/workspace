import { createTheme } from "@mantine/core";

/** One visual language for the shell and runtime-loaded plugin singletons. */
export const theme = createTheme({
  primaryColor: "blue",
  primaryShade: { light: 6, dark: 4 },
  fontFamily: '"Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif',
  fontFamilyMonospace: '"Cascadia Code", Consolas, monospace',
  defaultRadius: "md",
  headings: { fontWeight: "650" },
  cursorType: "pointer",
  focusRing: "auto",
  shadows: {
    xs: "0 1px 3px rgb(27 46 76 / 8%)",
    sm: "0 4px 12px rgb(27 46 76 / 10%)",
    md: "0 12px 32px rgb(27 46 76 / 16%)",
  },
  components: {
    ActionIcon: { defaultProps: { radius: "sm" } },
    Button: { defaultProps: { radius: "sm" } },
    TextInput: {
      defaultProps: { radius: "sm" },
      styles: {
        input: {
          backgroundColor: "var(--mantine-color-default-hover)",
          borderColor: "var(--mantine-color-default-border)",
          color: "var(--mantine-color-text)",
          "&:focus, &:focus-within": { borderColor: "var(--mantine-primary-color-filled)" },
        },
      },
    },
    SegmentedControl: {
      defaultProps: { radius: "sm" },
      styles: {
        root: { backgroundColor: "var(--mantine-color-default-hover)" },
        indicator: { backgroundColor: "var(--mantine-color-default)", boxShadow: "var(--mantine-shadow-xs)" },
        label: {
          color: "var(--mantine-color-dimmed)",
          "&[data-active]": { color: "var(--mantine-primary-color-filled)" },
        },
      },
    },
    Menu: {
      defaultProps: { radius: "md" },
      styles: { dropdown: { boxShadow: "var(--mantine-shadow-md)" }, item: { borderRadius: "var(--mantine-radius-sm)" } },
    },
    Tabs: {
      styles: {
        tab: {
          color: "var(--mantine-color-dimmed)",
          "&[data-active]": {
            color: "var(--mantine-primary-color-filled)",
            borderColor: "var(--mantine-primary-color-filled)",
          },
        },
      },
    },
    Tooltip: { defaultProps: { radius: "sm", withArrow: true } },
    Popover: { defaultProps: { radius: "md" }, styles: { dropdown: { boxShadow: "var(--mantine-shadow-md)" } } },
    Table: { styles: { td: { verticalAlign: "top" } } },
  },
});
