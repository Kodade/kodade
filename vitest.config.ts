import { defineConfig } from "vitest/config";
import packageJson from "./package.json";

// Frontend tests run in happy-dom so DOM globals (atob/btoa, TextEncoder) exist.
// We only test wiring/plumbing here — no xterm rendering.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __KODADE_RELEASE_PROFILE__: JSON.stringify("development"),
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.{ts,tsx}", "cli/**/*.test.ts"],
    // Marks the runtime as Tauri so the transport selector uses the desktop IPC
    // path by default (matching the suite's mocked-invoke wiring).
    setupFiles: ["./src/test-setup.ts"],
  },
});
