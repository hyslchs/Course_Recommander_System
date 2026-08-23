import { useEffect } from "react";
import { useLocation } from "react-router";

/**
 * Moves focus to the route's single `<h1>` after every navigation.
 *
 * Contract: each route renders exactly one `<h1>` inside `#main-content`
 * (pinned by `routeHeadings.test.tsx`). Routes are lazily loaded and some of
 * them swap their heading once data arrives, so this watches `#main-content`
 * for the whole route instead of looking exactly once:
 *
 * - the first heading of a route always takes focus;
 * - a replacement heading only reclaims focus that was dropped when the
 *   previous one unmounted (`/schedule` does this while it loads courses).
 *
 * Transient loading panels use `<h2 class="page-title">` so they never become
 * the focus target in the first place.
 */
export function RouteFocusManager() {
  const location = useLocation();
  useEffect(() => {
    const main = document.getElementById("main-content");
    let focusedHeading: HTMLElement | null = null;
    const focusHeading = () => {
      const heading = document.querySelector<HTMLElement>("#main-content h1");
      if (!heading || heading === focusedHeading) return;
      const active = document.activeElement;
      const focusWasLost = !active || active === document.body || active === document.documentElement;
      const first = !focusedHeading;
      focusedHeading = heading;
      if (!first && !focusWasLost) return;
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      if (first) heading.scrollIntoView({ block: "start" });
    };
    const observer = new MutationObserver(focusHeading);
    const frame = window.requestAnimationFrame(() => {
      focusHeading();
      if (main) observer.observe(main, { childList: true, subtree: true });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [location.pathname]);
  return null;
}
