import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Tailwind v4 runs through its own Vite plugin. This project has no PostCSS
  // pipeline and deliberately does not gain one.
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", sourcemap: "hidden" },
  server: {
    proxy: { "/api": "http://127.0.0.1:8080", "/health": "http://127.0.0.1:8080" },
  },
});
