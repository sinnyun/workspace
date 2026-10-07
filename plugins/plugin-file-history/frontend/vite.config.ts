import { defineConfig } from "vite";

// Library build -> a single ESM file the base loads at runtime via import().
// React, Mantine and the SDK stay EXTERNAL: the produced bundle keeps bare
// `import { useState } from 'react'` / `import { Timeline } from '@mantine/core'`,
// which the base's import map resolves to the shared singletons (docs/03 §5).
// Result: a tiny plugin bundle, one React/Mantine instance, consistent theme.
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
