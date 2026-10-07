import { useEffect, useState } from "react";
import { colorModeFor, type ColorMode } from "./theme";

function currentColorMode(): ColorMode {
  return colorModeFor(document.documentElement.dataset.theme, window.matchMedia("(prefers-color-scheme: dark)").matches);
}

/** Follows the board's theme live: a Settings change flips
 *  `data-theme` on <html>, and Auto follows the OS setting. */
export function useBoardColorMode(): ColorMode {
  const [mode, setMode] = useState<ColorMode>(currentColorMode);
  useEffect(() => {
    const update = () => setMode(currentColorMode());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  }, []);
  return mode;
}
