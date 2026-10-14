// web/src/main.tsx

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import WebAppeal from "./pages/WebAppeal";
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

// The web appeal link (pages/WebAppeal.tsx) is served from this same bundle
// (web/nginx.conf), but it's a public page, not the console: nothing there may
// load the console's server list or ask anyone to sign in on arrival.
const appeal = window.location.pathname.match(/^\/(?:ja\/)?appeal\/(\d{17,20})\/?$/);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {appeal ? <WebAppeal guildId={appeal[1]} /> : <App />}
  </React.StrictMode>,
);
