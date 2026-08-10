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
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
