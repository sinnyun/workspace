import { defineConfig } from "vite";

// Library build -> a single ESM file the base loads at runtime via import().
// React, Mantine (incl. spotlight) and the SDK stay EXTERNAL: the base's import
// map resolves them to the shared singletons (docs/03 §5), so one
// React/Mantine instance and one Spotlight store universe.
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
        "@mantine/spotlight",
        "@my-file-manager/plugin-sdk",
      ],
    },
  },
});
