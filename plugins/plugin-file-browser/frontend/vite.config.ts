import { defineConfig } from "vite";

// Library build -> a single ESM file the base loads at runtime via import().
// React, Mantine and the SDK stay EXTERNAL: the base's import map resolves them
// to the shared singletons (docs/03 §5), so one React/Mantine instance.
export default defineConfig({
  // @tanstack/react-virtual reads `process.env.NODE_ENV` at module scope; a browser
  // ESM chunk has no `process`, so inline it at build (same as react-arborist).
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
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
      external: [
        "react",
        "react/jsx-runtime",
        "react-dom",
        "react-dom/client",
        "@mantine/core",
        "@mantine/hooks",
        "@mantine/notifications",
        "@my-file-manager/plugin-sdk",
      ],
    },
  },
});
