import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Self-hosted fonts (SDD §3.1): bundled into dist/ by Vite, so the app
// works on the LAN with no internet and makes no Google Fonts call.
import "@fontsource/bricolage-grotesque/600.css";
import "@fontsource/bricolage-grotesque/700.css";
import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist/600.css";
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
