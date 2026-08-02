import { defineConfig } from "vitest/config";
import packageJson from "./package.json";

// A small second compile verifies the actual build-time constant. Ordinary
// tests intentionally use the development profile so unfinished features keep
// their own coverage while this suite pins their public absence.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __KODADE_RELEASE_PROFILE__: JSON.stringify("public"),
  },
  test: {
    environment: "happy-dom",
    include: ["src/release/public-build.public.ts"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
