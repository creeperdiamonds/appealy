// web/src/main.tsx

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initTheme } from "./lib/theme";

// BEFORE render, deliberately. Stamping the theme from inside a component runs
// after React's first paint, which means the console shows the default ground
// for a frame and then swaps — a flash of the wrong theme on every single load,
// which is worse than not having the feature.
initTheme();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
