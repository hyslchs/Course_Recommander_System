import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { setAnalyticsPage, track } from "./client";
import { pageForPath } from "./events";

/**
 * The only `page_view` producer, and the only place the route reaches analytics.
 *
 * `pageForPath` maps `location.pathname` through a fixed table, so what is
 * recorded is one of eight enum members — never the URL, never `location.search`
 * (which is where a mistyped student id or a pasted name would live), never
 * `document.title`.
 *
 * The `previous` ref makes the effect idempotent: `StrictMode` runs effects
 * twice in development, and without it every dev page load would report two
 * views.
 */
export function AnalyticsRouteTracker() {
  const { pathname } = useLocation();
  const previous = useRef("");

  useEffect(() => {
    const page = pageForPath(pathname);
    setAnalyticsPage(page);
    if (previous.current === pathname) return;
    previous.current = pathname;
    track("page_view", { page });
  }, [pathname]);

  return null;
}
