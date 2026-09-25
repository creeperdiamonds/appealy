// web/src/main.tsx

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initTheme } from "./lib/theme";
import { initLocale } from "./lib/i18n";

// BEFORE render, deliberately. Stamping the theme from inside a component runs
// after React's first paint, which means the console shows the default ground
// for a frame and then swaps — a flash of the wrong theme on every single load,
// which is worse than not having the feature.
initTheme();
// Same reasoning as initTheme above: deciding the language inside a
// component means React paints English, then swaps a frame later. It also
// stamps <html lang>, which screen readers and Safari's translation prompt
// both read before any component has mounted.
initLocale();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
