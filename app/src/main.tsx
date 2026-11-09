import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Self-hosted fonts (SDD §3.1): bundled into dist/ by Vite, so the app
// works on the LAN with no internet and makes no Google Fonts call.
import "@fontsource/figtree/400.css";
import "@fontsource/figtree/500.css";
import "@fontsource/figtree/600.css";
import "@fontsource/figtree/700.css";
import "@fontsource/figtree/800.css";
import "@fontsource/figtree/900.css";
import "@fontsource/geist-mono/400.css";
import { tokensToCss } from "./tokens";
import "./index.css";
import { App } from "./App";

const tokens = document.createElement("style");
tokens.id = "wissel-tokens";
tokens.textContent = tokensToCss();
document.head.prepend(tokens);

// The board's Light/Dark/Auto choice (src/api/public/board.html, key
// wissel-theme) applies here too, so the coordinator window docked
// beside the board follows its toggle; `storage` fires in this document
// when the board changes it. No stored choice: the OS decides.
function applyBoardTheme() {
  let theme: string | null = null;
  try {
    theme = localStorage.getItem("wissel-theme");
  } catch {
    // Storage blocked: Auto.
  }
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
applyBoardTheme();
window.addEventListener("storage", (e) => {
  if (e.key === null || e.key === "wissel-theme") applyBoardTheme();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
