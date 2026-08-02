import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
// Bundled brand default for terminal + editor (DESIGN.md §3). Latin subset only,
// weights 400/700 (~40KB woff2 total) — self-hosted, no network at runtime.
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
