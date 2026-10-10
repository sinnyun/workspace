import { defineConfig } from "vite";

// Library build -> a single ESM file the base loads at runtime via import().
// React, Mantine and the SDK stay EXTERNAL: the base's import map resolves them
// to the shared singletons (docs/03 §5), so one React/Mantine instance.
// echarts 的 ESM 产物里留着 `process.env.NODE_ENV` 的调试分支；运行时是浏览器，没有
// process，必须在打包时把那个表达式钉成 "production"，否则模块一求值就 ReferenceError。
export default defineConfig({
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
