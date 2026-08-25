import { useEffect, useRef, useState } from "react";

export const TABLE_LAYOUT_ANNOUNCEMENT = "版面已切換為表格檢視，結果以可排序的表格顯示。";
export const CARD_LAYOUT_ANNOUNCEMENT = "版面已切換為卡片檢視，結果以課程卡片顯示。";

/**
 * Hands focus over, and says so, when the explore page swaps its results layout.
 *
 * `useIsDesktop` unmounts one of two entirely different widgets — a React Aria
 * grid or a list of cards. If the thing you were on was inside the one that went
 * away, the browser drops focus onto `<body>`: the next Tab starts from the top
 * of the document, and a screen reader says nothing at all about why. This is not
 * a resize-only edge case. The breakpoint is `64rem`, so a browser text-size or
 * page-zoom change crosses it without the window ever moving, which is a setting
 * the users most likely to be navigating by keyboard are the most likely to have
 * changed.
 *
 * Modelled on `app/RouteFocusManager.tsx`, which solves the same problem for
 * route changes, and keeps its two rules:
 *
 * - only reclaim focus that was actually *lost* (`activeElement` is body /
 *   documentElement / nothing), never steal focus a user or a dialog has since
 *   placed somewhere deliberate;
 * - never fire on first paint — no layout "changed" when it is being drawn for
 *   the first time.
 *
 * It differs in target. A route change moves to the new page's `<h1>`; here the
 * heading did not change and re-announcing it would be a lie about what
 * happened. Focus goes to the results region itself, which is the nearest
 * ancestor that survives the swap, so the next Tab continues from where the user
 * was rather than from the top of the page.
 *
 * `focusin` on `document` rather than `onFocus` on the region, because the whole
 * point is to know where focus was *before* React removed the node: removing a
 * focused element fires no blur in most engines, so a `focusout` handler would
 * never learn about the case this exists for. The flag only ever moves when
 * focus lands somewhere, which is exactly the reading we want to keep.
 *
 * That flag is deliberately **fail-open**, and it is worth saying why, because
 * the obvious version (a boolean starting `false`) is wrong. Chrome does not
 * dispatch focus events at all while the *document* does not have system focus —
 * measured, not assumed: in headless Chrome `document.hasFocus()` is `false`,
 * `element.focus()` still moves `activeElement`, and a capturing `focusin`
 * listener records nothing. A boolean gate is therefore silently disarmed
 * whenever the window is in the background, which includes the ordinary case of
 * an OS-level or magnifier-driven resize done from another window. So the third
 * state is real: `"unknown"` means "no evidence either way" and is treated as
 * permission to proceed. Only positive evidence that focus was somewhere else
 * deliberately blocks the handoff — and `focusWasLost` blocks it anyway whenever
 * that somewhere else still exists.
 */
export function useLayoutSwitchFocus(isDesktop: boolean) {
  const regionRef = useRef<HTMLDivElement>(null);
  const lastFocusPlacement = useRef<"inside" | "outside" | "unknown">("unknown");
  const previousLayout = useRef(isDesktop);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const record = (event: FocusEvent) => {
      const region = regionRef.current;
      const inside = Boolean(region && event.target instanceof Node && region.contains(event.target));
      lastFocusPlacement.current = inside ? "inside" : "outside";
    };
    document.addEventListener("focusin", record);
    return () => document.removeEventListener("focusin", record);
  }, []);

  useEffect(() => {
    if (previousLayout.current === isDesktop) return;
    previousLayout.current = isDesktop;
    setAnnouncement(isDesktop ? TABLE_LAYOUT_ANNOUNCEMENT : CARD_LAYOUT_ANNOUNCEMENT);

    if (lastFocusPlacement.current === "outside") return;
    const region = regionRef.current;
    if (!region) return;
    const active = document.activeElement;
    const focusWasLost = !active || active === document.body || active === document.documentElement;
    if (!focusWasLost) return;
    // `preventScroll`, as in RouteFocusManager: the region is already where the
    // user is looking, and `scroll-behavior:smooth` would animate a jump to it.
    region.focus({ preventScroll: true });
  }, [isDesktop]);

  return { announcement, regionRef };
}
