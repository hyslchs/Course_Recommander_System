import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router";
import { I18nProvider } from "@heroui/react";
import App from "./app/App";
import "./styles.css";
import { FeedbackProvider } from "./components/ui";
import { ThemeProvider } from "./hooks/theme";

// React Aria's built-in announcements ("N results available", date/number
// formatting, collator-based filtering) default to English. HeroUI v3 needs no
// provider of its own, but it does need this one. Plan R11.
//
// `zh-TW`, NOT `zh-Hant-TW`, and this is load-bearing. React Aria ships exactly
// two Chinese bundles, keyed `zh-CN` and `zh-TW`, and resolves a locale in
// LocalizedStringDictionary by: exact key -> `<lang>-<script>` -> `<lang>` ->
// **the first key that starts with `<lang>-`** -> English. `zh-Hant-TW` misses
// the first three (there is no `zh-Hant` or `zh` bundle) and lands on that
// fourth rule, which returns `zh-CN` because it is emitted first — so every
// built-in announcement came out in Simplified Chinese. Measured on
// /onboarding: the department ComboBox announced 「有 67 个选项可用。」.
// `zh-TW` hits the exact key. Both canonicalise to the same Intl locale
// (`zh-TW`.maximize() === `zh-Hant-TW`), so number/date/collation are unchanged.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider locale="zh-TW">
      {/* Outside FeedbackProvider: the theme is document-level state that every
          overlay portal inherits through `data-theme` on <html>, and it must
          resolve whether or not anything below it renders. */}
      <ThemeProvider>
        <FeedbackProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </FeedbackProvider>
      </ThemeProvider>
    </I18nProvider>
  </React.StrictMode>,
);
