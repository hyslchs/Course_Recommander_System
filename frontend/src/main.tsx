import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles.css";
import "./courseVariants.css";
import { FeedbackProvider } from "./ui";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FeedbackProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </FeedbackProvider>
  </React.StrictMode>,
);
