import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

/**
 * Serves the static marketing site at / during development.
 *
 * In production nginx does this: site/ at the root, the console under
 * /dashboard/. Without an equivalent here, development would be the one place
 * where visiting / gives you the console — and "works in dev" would stop
 * meaning anything about the thing people actually land on.
 *
 * Deliberately dumb: read the file, send it. No watching, no HMR. The site is
 * static HTML and a reload is the whole development loop for it.
 */
function marketingSite(): Plugin {
  const root = path.resolve(__dirname, "../site");
  const types: Record<string, string> = {
    ".html": "text/html",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".js": "text/javascript",
    ".png": "image/png",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
  };

  return {
    name: "appealy-marketing-site",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "/").split("?")[0];
        // Everything the app owns keeps its normal handling.
        if (url.startsWith("/dashboard") || url.startsWith("/api") || url.startsWith("/auth")) {
          return next();
        }

        const rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
        // Extensionless paths get .html, so /pricing serves pricing.html the
        // way nginx will.
        const candidates = path.extname(rel) ? [rel] : [`${rel}.html`, path.join(rel, "index.html")];

        for (const candidate of candidates) {
          const file = path.resolve(root, candidate);
          // Refuse anything that escapes site/ — this middleware reads from
          // disk by request path, which is the shape of a traversal bug.
          if (!file.startsWith(root)) break;
          if (fs.existsSync(file) && fs.statSync(file).isFile()) {
            res.setHeader("Content-Type", types[path.extname(file)] ?? "application/octet-stream");
            res.end(fs.readFileSync(file));
            return;
          }
        }
        next();
      });
    },
  };
}

// Port 5173 is not arbitrary — it's what FRONTEND_ORIGIN and
// DASHBOARD_BASE_URL already default to in .env.example, and what the API's
// CORS origin is set from. Changing it here means changing it in three
// other places, so it stays.
export default defineConfig({
  // The console lives under /dashboard/, not at the root.
  //
  // The OAuth callback has always redirected to `${FRONTEND_ORIGIN}/dashboard`
  // — the split was assumed from the beginning; there was simply nothing at
  // the root to assume it against. Setting base here makes the built asset
  // URLs match, so the bundle is requested from /dashboard/assets/ rather than
  // from /assets/, which is where the marketing site now lives.
  base: "/dashboard/",
  plugins: [react(), marketingSite()],
  server: {
    port: 5173,
    strictPort: true,

    // Mirrors what web/nginx.conf does in the built image: the API is reached
    // through the dev server's own origin rather than at localhost:3001, so
    // the session cookie is first-party here exactly as it is in production.
    //
    // This is not only a convenience. Calling the API cross-origin works in
    // dev by accident — localhost:5173 and localhost:3001 differ only by
    // port, and ports are not part of a "site", so a SameSite=Lax cookie is
    // still sent. That accident does not survive deployment to two different
    // hostnames, and developing against the lenient case is how the
    // difference stays invisible until it is in front of users.
    //
    // Only the API's real prefixes are proxied; /webhooks (Tebex) and
    // /health are hit on the API directly and have no reason to be reachable
    // through the console.
    proxy: {
      "/auth": { target: "http://localhost:3001" },
      "/api": { target: "http://localhost:3001" },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
