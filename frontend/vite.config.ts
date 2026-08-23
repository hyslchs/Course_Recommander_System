import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Drop fontsource's legacy `.woff` fallbacks from the production build.
 *
 * Every @font-face fontsource ships lists `url(x.woff2) format('woff2'),
 * url(x.woff) format('woff')`. Browsers pick the first format they support and
 * woff2 has been universal since 2016 (Chrome 36, Safari 10, Firefox 39,
 * Edge 14) — far older than the React 19 / ES2022 floor this app already has —
 * so the `.woff` half is never requested by anyone. Vite still emits it: for
 * the four weights x 105 unicode-range slices of Noto Sans TC that is 408
 * extra files and 11.5 MB of dist, shipped in every Docker image, downloaded
 * by nobody.
 *
 * This has to run in `generateBundle` rather than `transform`, because Vite
 * inlines CSS `@import` inside its own CSS pipeline — a `transform` hook never
 * sees @fontsource's stylesheets as modules. By `generateBundle` the CSS is one
 * asset with the hashed filenames already substituted, so stripping the
 * reference and deleting the orphaned asset stay consistent.
 *
 * Dev needs no equivalent: the browser picks woff2 out of the src list there
 * too, it just does it against unbundled node_modules paths.
 *
 * If a fontsource upgrade changes the `src:` shape this throws rather than
 * silently shipping 11.5 MB again.
 */
function dropLegacyWoffFallback(): Plugin {
  const legacySource = /,\s*url\([^)]+?\.woff\)\s*format\(\s*(['"])woff\1\s*\)/g;
  return {
    name: "fju-drop-legacy-woff-fallback",
    apply: "build",
    generateBundle(_options, bundle) {
      // `for...in` rather than Object.entries: tsconfig.node.json targets ES5.
      let rewritten = 0;
      let deleted = 0;
      for (const fileName in bundle) {
        const asset = bundle[fileName];
        if (asset.type !== "asset") continue;
        if (fileName.endsWith(".woff")) {
          delete bundle[fileName];
          deleted += 1;
          continue;
        }
        if (!fileName.endsWith(".css")) continue;
        const css = typeof asset.source === "string" ? asset.source : asset.source.toString();
        const next = css.replace(legacySource, "");
        if (next === css) continue;
        asset.source = next;
        rewritten += 1;
      }
      if (deleted > 0 && rewritten === 0) {
        throw new Error(
          "fju-drop-legacy-woff-fallback: .woff assets were emitted but no `url(...woff) " +
            "format('woff')` source was found to strip. The @fontsource `src:` shape " +
            "changed — fix the regex instead of removing this plugin.",
        );
      }
      this.info(`dropped ${deleted} legacy .woff assets from ${rewritten} stylesheet(s)`);
    },
  };
}

export default defineConfig({
  // Tailwind v4 runs through its own Vite plugin. This project has no PostCSS
  // pipeline and deliberately does not gain one.
  plugins: [react(), tailwindcss(), dropLegacyWoffFallback()],
  // `@/*` must be declared here, in tsconfig.app.json AND in vitest.config.ts.
  resolve: { alias: { "@": "/src" } },
  build: { outDir: "dist", sourcemap: "hidden" },
  server: {
    proxy: { "/api": "http://127.0.0.1:8080", "/health": "http://127.0.0.1:8080" },
  },
});
