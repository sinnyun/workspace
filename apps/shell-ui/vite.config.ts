import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The shared singletons prebuilt by scripts/build-shared.mjs into shared-dist/
// (production) and shared-dist-dev/ (development). The HOST must load these exact
// files too — if the host bundled its own React, host and runtime plugins would
// hold two Reacts and hooks/Mantine context would break. Mapping each bare
// specifier to a fixed external URL makes the host emit
// `import ... from '<base>/react.js'`, the same URL the import map hands plugins,
// so there is ONE React/Mantine instance everywhere.
//
// Two mode-consistent variants exist because React's dev and prod builds expose
// different internals (dev jsxDEV needs `dispatcher.getOwner`, absent in prod):
// `vite dev` uses the development set, the shipped build the production set.
// (NOT under public/: vite forbids importing public files from source in dev.)
const SPECIFIERS: Record<string, string> = {
  react: "react.js",
  "react/jsx-runtime": "jsx-runtime.js",
  "react/jsx-dev-runtime": "jsx-dev-runtime.js",
  "react-dom": "react-dom.js",
  "react-dom/client": "react-dom-client.js",
  "@mantine/core": "mantine-core.js",
  "@mantine/hooks": "mantine-hooks.js",
  "@mantine/notifications": "mantine-notifications.js",
  "@mantine/spotlight": "mantine-spotlight.js",
  "@my-file-manager/plugin-sdk": "plugin-sdk.js",
};

function sharedUrls(base: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [spec, file] of Object.entries(SPECIFIERS)) out[spec] = `${base}/${file}`;
  return out;
}

// Exact-match only: `@mantine/core/styles.css` must NOT match `@mantine/core`
// (CSS is bundled normally by the host).
function sharedSingletons(shared: Record<string, string>): Plugin {
  return {
    name: "shared-singletons",
    enforce: "pre",
    resolveId(source) {
      const url = shared[source];
      if (!url) return null;
      // External absolute URL: kept verbatim in dev and in the prod bundle.
      return { id: url, external: true };
    },
  };
}

// Serve the prebuilt singletons over HTTP in dev: `/shared/*` -> shared-dist/ and
// `/shared-dev/*` -> shared-dist-dev/. On build, emit ONLY the production set into
// `dist/shared/*` (the dev set never ships).
function sharedVendor(): Plugin {
  const dirs: Record<string, string> = {
    "/shared": fileURLToPath(new URL("./shared-dist/", import.meta.url)),
    "/shared-dev": fileURLToPath(new URL("./shared-dist-dev/", import.meta.url)),
  };
  // Dev only: the bare specifiers resolve to external `/shared[-dev]/*.js` urls.
  // Vite's dev server ignores `external` and still tries to LOAD that id for the
  // module graph (pre-transform of main.tsx), which fails against the filesystem
  // and throws "Failed to load url /shared-dev/react.js". Feed it the prebuilt
  // file here so the graph can load it; the browser still gets the same url from
  // the middleware below, so there's a single instance. On build these are truly
  // external and this hook is never hit for them.
  return {
    name: "shared-vendor",
    load(id) {
      const [prefix, dir] = Object.entries(dirs).find(([p]) => id.startsWith(`${p}/`)) ?? [];
      if (!prefix || !dir) return null;
      const rel = id.slice(prefix.length + 1).split("?")[0];
      const file = resolve(dir, rel);
      if (!file.startsWith(dir)) return null;
      try {
        return readFileSync(file, "utf-8");
      } catch {
        return null;
      }
    },
    configureServer(server) {
      for (const [prefix, dir] of Object.entries(dirs)) {
        server.middlewares.use(prefix, (req, res, next) => {
          // connect strips the mount prefix, so req.url is the path within dir.
          const rel = decodeURIComponent(req.url ?? "")
            .split("?")[0]
            .replace(/^\/+/, "");
          if (!rel) return next();
          const file = resolve(dir, rel);
          if (!file.startsWith(dir)) {
            res.statusCode = 403;
            return res.end("forbidden");
          }
          try {
            const data = readFileSync(file);
            res.setHeader("Content-Type", "text/javascript");
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Cache-Control", "no-store");
            res.end(data);
          } catch {
            next();
          }
        });
      }
    },
    generateBundle() {
      const dir = dirs["/shared"];
      for (const name of readdirSync(dir)) {
        this.emitFile({
          type: "asset",
          fileName: `shared/${name}`,
          source: readFileSync(resolve(dir, name)),
        });
      }
    },
  };
}

// index.html's import map lists the PRODUCTION urls (`/shared/*`). In dev, rewrite
// them to the development set so host and plugins both get mode-consistent React.
function devImportMap(): Plugin {
  return {
    name: "dev-import-map",
    apply: "serve",
    transformIndexHtml(html) {
      return html.replaceAll('"/shared/', '"/shared-dev/');
    },
  };
}

// Dev-only: serve built frontend plugins at /dev-plugins/<name>/<relpath> from
// ../../plugins/<name>/frontend/dist/<relpath>. This lets `vite dev` exercise the
// real runtime-ESM plugin loading path in a plain browser (no Tauri), where the
// `plugin://` scheme doesn't exist. Production/Tauri uses `plugin://` instead.
/**
 * The same table as the host's `guess_mime` (apps/host/src/lib.rs): a plugin asset
 * must arrive with the MIME it would get over `plugin://`, or dev passes/fails where
 * the shipped app does the opposite. `.mjs` is the case that matters — pdf.js loads
 * its worker as a module script, and a stream MIME makes the browser refuse it.
 */
function pluginContentType(file: string): string {
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript";
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".css")) return "text/css";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

function devPluginServer(): Plugin {
  return {
    name: "dev-plugin-server",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/dev-plugins", (req, res, next) => {
        const segs = decodeURIComponent(req.url ?? "")
          .split("/")
          .filter(Boolean);
        const [name, ...rest] = segs;
        if (!name || rest.length === 0) return next();
        const base = fileURLToPath(new URL(`../../plugins/${name}/frontend/dist/`, import.meta.url));
        const file = fileURLToPath(new URL(`../../plugins/${name}/frontend/dist/${rest.join("/")}`, import.meta.url));
        if (!file.startsWith(base)) {
          res.statusCode = 403;
          return res.end("forbidden");
        }
        try {
          const data = readFileSync(file);
          res.setHeader("Content-Type", pluginContentType(file));
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Cache-Control", "no-store");
          res.end(data);
        } catch {
          next();
        }
      });
    },
  };
}

export default defineConfig(({ command }) => {
  const base = command === "serve" ? "/shared-dev" : "/shared";
  const shared = sharedUrls(base);
  return {
    plugins: [sharedSingletons(shared), sharedVendor(), devImportMap(), devPluginServer(), react()],
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
    },
    // All heavy libs are externalized to the shared singletons (import map) and
    // the only real node_modules deps (zustand, @tauri-apps/api) are ESM. Disable
    // dep discovery so the scanner never tries to read the external URLs from disk.
    optimizeDeps: {
      noDiscovery: true,
      include: [],
    },
    build: {
      target: "es2022",
      // Shared libs are external (loaded from /shared); bundle the rest.
      rollupOptions: {
        output: {
          // Keep the host's own code in predictable chunks; no vendor splitting
          // needed since the big libs are external now.
          inlineDynamicImports: true,
        },
      },
    },
  };
});
