import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import packageJson from "./package.json";

export default defineConfig(({ command, mode }) => ({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __KODADE_RELEASE_PROFILE__: JSON.stringify(
      command === "serve" || mode === "development-features"
        ? "development"
        : "public",
    ),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
}));
