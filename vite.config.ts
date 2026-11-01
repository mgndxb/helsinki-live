import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Served as a GitHub Pages project site, which appears under the portfolio's
// custom domain at magnus.is-a.dev/helsinki-live/.
export default defineConfig({
  base: "/helsinki-live/",
  plugins: [react(), tailwindcss()],
  worker: { format: "es" },
  // MapLibre is most of the bundle and loads in one piece; splitting it gains nothing here.
  build: { chunkSizeWarningLimit: 1_500 },
});
