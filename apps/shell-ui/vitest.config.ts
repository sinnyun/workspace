import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Deliberately NOT reusing vite.config.ts: that one externalises React/Mantine/
// plugin-sdk to the prebuilt shared singletons, which only exist as served URLs.
// Unit tests render the real components, so they resolve normal npm packages
// (the plugin-sdk workspace link points straight at its TypeScript source).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
