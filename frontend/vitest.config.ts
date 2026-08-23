import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // This root config does NOT inherit vite.config.ts, so the React plugin and the
  // `@/*` alias both have to be repeated here.
  plugins: [react()],
  resolve: { alias: { "@": "/src" } },
  test: {
    environment: "jsdom",
    // Vitest 4 narrowed the default `exclude` to node_modules/.git, so a built `dist/` would
    // otherwise be collected as test files. Scoping the run to `src` is the supported fix.
    dir: "src",
    // Required for @testing-library/react to register its automatic `afterEach(cleanup)` hook.
    globals: true,
    // jsdom has no ResizeObserver; HeroUI's Toast needs one. See the file.
    setupFiles: ["./src/test/setup.ts"],
  },
});
