import { builtinModules } from "node:module";
import { defineConfig } from "vite";

/** Module specifiers the viewer dependency graph only reaches for under Node:
 *  pdf.js's optional native canvas bindings, `emf-converter`'s skia addon, and
 *  the node builtins they pull in. Bundling them is impossible (a `.node` binary
 *  is not JavaScript) and pointless (a WebView never runs that branch), so they
 *  stay external — the code path that imports them cannot be reached in this app. */
const NODE_ONLY = new Set([
  "@napi-rs/canvas",
  "canvas",
  "pdfjs-dist/build/pdf.node.mjs",
  "pdfjs-dist/legacy/build/pdf.node.mjs",
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

const SHARED_SINGLETONS = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@mantine/core",
  "@mantine/hooks",
  "@mantine/notifications",
  "@my-file-manager/plugin-sdk",
];

const isExternal = (source: string): boolean =>
  SHARED_SINGLETONS.includes(source) ||
  NODE_ONLY.has(source) ||
  source.endsWith(".node") ||
  source.includes("pdf.node.mjs");

// Library build -> a single ESM file the base loads at runtime via import().
// React, Mantine and the SDK stay EXTERNAL: the base's import map resolves them
// to the shared singletons (docs/03 §5), so one React/Mantine instance.
export default defineConfig({
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: "src/index.tsx",
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: isExternal,
    },
  },
});
