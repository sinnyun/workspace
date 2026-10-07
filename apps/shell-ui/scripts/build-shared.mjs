// Prebuild the shared singletons (React, Mantine, SDK) as fixed-name ESM files
// under shared-dist/. Each package is built as a SINGLE-ENTRY lib so rollup
// preserves its named exports and does not create cross-chunk duplicates; every
// other shared package is marked external so they all resolve to one another via
// the import map in index.html. This is what makes host + plugins share ONE
// React (hooks don't break) and ONE Mantine (theme/portals stay consistent).
//
// Run: node scripts/build-shared.mjs   (wired as `pnpm --filter shell-ui build:shared`)
import { build } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
// NOT under public/: vite forbids importing public files from source in dev. The
// vite config serves these dirs at `/shared/*` (prod) and `/shared-dev/*` (dev)
// and emits the prod dir into `dist/shared/*` on build.
const outDir = resolve(root, "shared-dist");
const devDir = resolve(root, "shared-dist-dev");
const tmpDir = resolve(root, "node_modules/.shared-entries");

// bare specifier -> output file basename
const shared = {
  react: "react",
  "react-dom": "react-dom",
  "react-dom/client": "react-dom-client",
  "react/jsx-runtime": "jsx-runtime",
  "react/jsx-dev-runtime": "jsx-dev-runtime",
  "@mantine/core": "mantine-core",
  "@mantine/hooks": "mantine-hooks",
  "@mantine/notifications": "mantine-notifications",
  "@my-file-manager/plugin-sdk": "plugin-sdk",
};

// Everything shared is external to every other shared build, so the import map
// (not the bundler) is the single resolution point at runtime.
const external = Object.keys(shared);

// CJS-backed packages. `export *` from a CommonJS module yields NO static named
// exports through rollup (only `default`), which breaks consumers doing
// `import { useState } from "react"`. For these we enumerate the runtime keys at
// build time and emit explicit `export const X = __d["X"]` re-exports so the ESM
// facade has real static named exports. The ESM packages (Mantine, SDK) keep
// `export *`, which preserves their native named exports.
const cjsSpecs = new Set([
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
]);

/** Enumerate a module's export names at build time (Node's CJS interop). */
async function exportNamesOf(spec) {
  const m = await import(spec);
  const names = new Set();
  for (const k of Object.keys(m)) if (k !== "default") names.add(k);
  const def = m.default;
  if (def && typeof def === "object") {
    for (const k of Object.keys(def)) if (k !== "default") names.add(k);
  }
  // Keep only valid JS identifiers (cjs-module-lexer can surface junk keys like
  // "module.exports" that cannot become `export const` bindings).
  const valid = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  return [...names].filter((n) => valid.test(n));
}

rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

// Two mode-consistent variants. React's dev and prod builds expose DIFFERENT
// internals (e.g. dev jsxDEV needs `dispatcher.getOwner`, absent in prod), so a
// dev jsx-runtime cannot share a prod react core. `vite dev` loads shared-dist-dev
// (all development) via the rewritten import map; the shipped build loads
// shared-dist (all production). Within one mode every consumer — host and
// plugins alike — resolves to the same variant, keeping ONE React instance.
const modes = [
  { nodeEnv: "production", dir: outDir },
  { nodeEnv: "development", dir: devDir },
];

for (const { nodeEnv, dir } of modes) {
  mkdirSync(dir, { recursive: true });
  for (const [spec, base] of Object.entries(shared)) {
    // A real entry file per package that re-exports the module. Physical entries
    // resolve reliably in Vite lib mode.
    const entryPath = resolve(tmpDir, `${base}.js`);
    let source;
    if (cjsSpecs.has(spec)) {
      const names = await exportNamesOf(spec);
      source =
        `import __d from ${JSON.stringify(spec)};\n` +
        `export default __d;\n` +
        names.map((n) => `export const ${n} = __d[${JSON.stringify(n)}];`).join("\n") +
        "\n";
    } else {
      source = `export * from ${JSON.stringify(spec)};\n`;
    }
    writeFileSync(entryPath, source);

    await build({
      root,
      configFile: false,
      logLevel: "warn",
      define: { "process.env.NODE_ENV": JSON.stringify(nodeEnv) },
      build: {
        write: true,
        emptyOutDir: false,
        outDir: dir,
        minify: false,
        lib: {
          entry: entryPath,
          formats: ["es"],
          fileName: () => `${base}.js`,
        },
        rollupOptions: {
          // The package being bundled stays internal; OTHER shared packages are
          // external so they resolve via the import map to the same singletons.
          // A package's own subpath (e.g. react-dom/client -> react-dom) must also
          // stay external to avoid duplicating the parent.
          external: external.filter((e) => e !== spec),
          output: { inlineDynamicImports: true },
        },
      },
    });
    console.log(`  ✓ ${nodeEnv}/${base}.js  <-  ${spec}`);
  }
}

rmSync(tmpDir, { recursive: true, force: true });
console.log("shared singletons built into shared-dist/ and shared-dist-dev/");
