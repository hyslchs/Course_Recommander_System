import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router";
import { I18nProvider } from "@heroui/react";
import App from "./App";
import "./styles.css";
import "./courseVariants.css";
import { FeedbackProvider } from "./ui";

// React Aria's built-in announcements ("N results available", date/number
// formatting, collator-based filtering) default to English. HeroUI v3 needs no
// provider of its own, but it does need this one. Plan R11.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider locale="zh-Hant-TW">
      <FeedbackProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </FeedbackProvider>
    </I18nProvider>
  </React.StrictMode>,
);
