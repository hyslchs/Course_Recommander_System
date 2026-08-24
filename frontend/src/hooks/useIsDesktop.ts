import { useCallback, useSyncExternalStore } from "react";

/**
 * Tailwind's `lg` breakpoint, in the same unit Tailwind emits (`64rem`), so the
 * JS switch and the CSS media queries flip on the *same* pixel even when the
 * root font size is not 16px. Hard-coding `1024px` here would desynchronise the
 * two the moment a user enlarges their browser's default text size.
 */
export const DESKTOP_QUERY = "(min-width: 64rem)";

/**
 * True at `lg` and above.
 *
 * Deliberately a JS media query rather than rendering both layouts and hiding
 * one with `lg:hidden` / `hidden lg:block`. Each `<lg` result is a `CourseCard`,
 * and a card is not cheap: it subscribes to three local-data stores, the active
 * plan and the feedback context, and evaluates eligibility. Rendering 25 of them
 * behind `display:none` next to a table costs all of that for markup nobody can
 * see. `useSyncExternalStore` keeps it tear-free under concurrent rendering and
 * needs no effect to prime the first paint.
 *
 * jsdom ships no layout, and `test/setup.ts` stubs `matchMedia` to report "no
 * match", so tests land on the card layout unless they override the stub — which
 * is exactly what makes the breakpoint switch testable.
 */
export function useIsDesktop(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
    const list = window.matchMedia(DESKTOP_QUERY);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, []);
  const getSnapshot = useCallback(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(DESKTOP_QUERY).matches;
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
