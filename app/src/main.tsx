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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
