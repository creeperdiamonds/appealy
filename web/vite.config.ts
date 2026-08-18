import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Port 5173 is not arbitrary — it's what FRONTEND_ORIGIN and
// DASHBOARD_BASE_URL already default to in .env.example, and what the API's
// CORS origin is set from. Changing it here means changing it in three
// other places, so it stays.
export default defineConfig({
  plugins: [react()],
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
