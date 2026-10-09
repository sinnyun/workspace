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
import { registerMocks } from "./dev-mocks";

async function bootstrap() {
  // Browser-dev fallbacks so the shell is runnable without the Tauri host.
  registerMocks();

  // The cascade store must own the coordination events before anything publishes.
  initCascadeBus();

  // Mirror backend cordis events onto the frontend bus (no-op outside Tauri).
  await bus.bridgeBackend(["file:changed", "history:updated"]);

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
