import React from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./styles.css";
import { theme } from "./theme";

import { App } from "./App";
import { bus } from "./eventbus";
import { initCascadeBus } from "./state";
import { loadPlugins } from "./loader";
import { registerClipboardCapability } from "./clipboard";
import { registerMocks } from "./dev-mocks";

async function bootstrap() {
  // Browser-dev fallbacks so the shell is runnable without the Tauri host.
  registerMocks();

  // Base-served capabilities (no Rust counterpart) answer before plugin load,
  // so a plugin can invoke them during `activate`.
  registerClipboardCapability();

  // The cascade store must own the coordination events before anything publishes.
  initCascadeBus();

  // Mirror backend cordis events onto the frontend bus (no-op outside Tauri).
  // `shell:operation:*` are the only channel through which a Shell file
  // operation reports the truth — `shell.fileOperation` itself only acks.
  await bus.bridgeBackend([
    "file:changed",
    "history:updated",
    "shell:operation:progress",
    "shell:operation:done",
  ]);

  // Load runtime frontend plugins over plugin:// (empty list outside Tauri).
  await loadPlugins(() => {
    /* slot changes re-render via the registry subscription */
  });

  const root = createRoot(document.getElementById("root")!);
  root.render(
    <React.StrictMode>
      <MantineProvider theme={theme} defaultColorScheme="light">
        <Notifications position="top-right" />
        <App />
      </MantineProvider>
    </React.StrictMode>,
  );
}

void bootstrap();
