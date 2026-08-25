import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Moon, Sun } from "@phosphor-icons/react";
import { THEME_DARK, THEME_LIGHT, useTheme, type ThemeName } from "@/hooks/theme";
import { useReducedMotion } from "@/hooks/useReducedMotion";

/** Reveal length. 400ms is the registry default and reads as one gesture. */
const TRANSITION_DURATION = 400;

/** Marks a running transition, for the CSS in `styles.css` and as a re-entry guard. */
const VT_ACTIVE_ATTRIBUTE = "fjuThemeVt";
const VT_CLIP_FROM_PROPERTY = "--fju-theme-vt-clip-from";
const VT_DURATION_PROPERTY = "--fju-theme-vt-duration";

interface ViewTransitionLike {
  finished?: Promise<unknown>;
  ready?: Promise<unknown>;
}

type StartViewTransition = (callback: () => void) => ViewTransitionLike;

/**
 * The collapsed and expanded circles, both as percentages of the snapshot
 * reference box.
 *
 * Percentages, not pixels, is the registry's fix for a real Chrome bug: on a
 * fractional display scale Chrome renders absolute px clip-path coordinates on
 * `::view-transition-new(root)` unscaled for the first transition after load, so
 * the reveal starts in the wrong place. Percentages resolve against the box, so
 * the scale cancels out. `circle()` percentage radii resolve against
 * `hypot(w, h) / sqrt(2)` of that box, hence the divisor.
 */
export function themeRevealClipPaths(
  cx: number, cy: number, maxRadius: number, viewportWidth: number, viewportHeight: number,
): [string, string] {
  const at = `${(cx / viewportWidth) * 100}% ${(cy / viewportHeight) * 100}%`;
  const radius = (maxRadius / (Math.hypot(viewportWidth, viewportHeight) / Math.SQRT2)) * 100;
  return [`circle(0% at ${at})`, `circle(${radius}% at ${at})`];
}

export interface ThemeToggleProps {
  className?: string;
}

/**
 * Light/dark switch. Adapted from Magic UI `animated-theme-toggler`.
 *
 * WHAT CHANGED FROM THE REGISTRY SOURCE:
 *
 * 1. **It wrote a class; it now writes an attribute.** The upstream
 *    `applyTheme()` runs `document.documentElement.classList.toggle("dark")`
 *    *unconditionally*, including in controlled mode, with a source comment
 *    explaining that the class exists so the View Transitions API snapshots the
 *    new theme inside the `startViewTransition` callback. The snapshot reasoning
 *    is right and is kept — but this project themes with `data-theme`
 *    (`theme/fju.css` keys every token off `[data-theme="fju"|"fju-dark"]`, and
 *    `styles.css` redefines Tailwind's `dark:` variant to match `fju-dark`).
 *    Leaving the class in would have produced a `.dark` class and a `data-theme`
 *    attribute disagreeing with each other on every toggle. The line is now
 *    `document.documentElement.dataset.theme = next`, which is just as
 *    synchronous, so the snapshot still sees the new theme.
 * 2. **Controlled only.** Upstream's uncontrolled path reads the `.dark` class
 *    through a `MutationObserver` and persists to `localStorage`; here
 *    `ThemeProvider` owns both, with IndexedDB as the store of record.
 * 3. **Phosphor, not lucide.** The registry depends on `lucide-react`; §4.6 says
 *    no second icon library, and `@phosphor-icons/react` is already a dependency.
 * 4. **`cn` / `@/lib/utils` removed** — the helper does not exist in this repo.
 * 5. **Six of the seven `TransitionVariant` shapes dropped.** Star, hexagon and
 *    friends are ~120 lines of polygon maths for a control that has one job.
 * 6. **Reduced motion skips `startViewTransition` entirely.** This one is not
 *    cosmetic: the reveal is driven by `Element.animate()`, a Web Animations
 *    API call whose duration is a JS number. The global
 *    `@media (prefers-reduced-motion: reduce)` block in `styles.css` sets
 *    `animation-duration` on CSS animations and cannot touch it. Skipping the
 *    call is the only thing that actually stops it.
 * 7. **A real accessible name, in zh-Hant, plus a live region.** Upstream ships
 *    `<span className="sr-only">Toggle theme</span>`. The name here states the
 *    action ("切換為深色模式"), and the resulting state is announced politely
 *    after the switch ("已切換為深色模式") so the change is not silent.
 */
export function ThemeToggle({ className }: ThemeToggleProps) {
  const { isDark, setTheme } = useTheme();
  const reducedMotion = useReducedMotion();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const animationRef = useRef<Animation | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => () => {
    animationRef.current?.cancel();
    const root = document.documentElement;
    if (root.dataset[VT_ACTIVE_ATTRIBUTE] !== "active") return;
    delete root.dataset[VT_ACTIVE_ATTRIBUTE];
    root.style.removeProperty(VT_DURATION_PROPERTY);
    root.style.removeProperty(VT_CLIP_FROM_PROPERTY);
  }, []);

  const toggle = useCallback(() => {
    const root = document.documentElement;
    const next: ThemeName = isDark ? THEME_LIGHT : THEME_DARK;
    const apply = () => {
      // Attribute, not classList. See note 1 above.
      root.dataset.theme = next;
      setTheme(next);
    };
    setAnnouncement(next === THEME_DARK ? "已切換為深色模式" : "已切換為淺色模式");

    const startViewTransition = (document as Document & { startViewTransition?: StartViewTransition })
      .startViewTransition;
    const button = buttonRef.current;
    if (reducedMotion || typeof startViewTransition !== "function" || !button
      || root.dataset[VT_ACTIVE_ATTRIBUTE] === "active") {
      apply();
      return;
    }

    // innerWidth/innerHeight, not visualViewport: the percentages above resolve
    // against the snapshot reference box, which includes classic scrollbars.
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const box = button.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const maxRadius = Math.hypot(Math.max(cx, viewportWidth - cx), Math.max(cy, viewportHeight - cy));
    const clipPath = themeRevealClipPaths(cx, cy, maxRadius, viewportWidth, viewportHeight);

    root.dataset[VT_ACTIVE_ATTRIBUTE] = "active";
    root.style.setProperty(VT_DURATION_PROPERTY, `${TRANSITION_DURATION}ms`);
    // Pin the collapsed clip-path in CSS so the new theme is never painted
    // unclipped in the gap between the snapshot and the `ready` callback.
    root.style.setProperty(VT_CLIP_FROM_PROPERTY, clipPath[0]);
    const cleanup = () => {
      delete root.dataset[VT_ACTIVE_ATTRIBUTE];
      root.style.removeProperty(VT_DURATION_PROPERTY);
      root.style.removeProperty(VT_CLIP_FROM_PROPERTY);
      animationRef.current?.cancel();
      animationRef.current = null;
    };

    // `flushSync` so React has committed the new theme before the callback
    // returns and the API takes its "new" snapshot.
    const transition = startViewTransition.call(document, () => flushSync(apply));
    if (transition.finished) void transition.finished.then(cleanup, cleanup);
    else cleanup();
    if (transition.ready) {
      void transition.ready.then(() => {
        animationRef.current = root.animate({ clipPath }, {
          duration: TRANSITION_DURATION,
          easing: "ease-in-out",
          fill: "forwards",
          pseudoElement: "::view-transition-new(root)",
        });
      }, () => {});
    }
  }, [isDark, reducedMotion, setTheme]);

  return (
    <>
      <button
        ref={buttonRef}
        aria-label={isDark ? "切換為淺色模式" : "切換為深色模式"}
        className={className ? `icon-button theme-toggle ${className}` : "icon-button theme-toggle"}
        type="button"
        onClick={toggle}
      >
        {isDark ? <Sun aria-hidden="true" weight="fill" /> : <Moon aria-hidden="true" weight="fill" />}
      </button>
      {/* `aria-live` without `role="status"`. The role is only shorthand for
          this attribute, and adding it would put a second `status` element in
          every route — `routeHeadings.test.tsx` asks for THE status element
          while a page is loading, and two of them is an ambiguous query. The
          region is rendered empty from the first paint on purpose: a live
          region has to exist before its content changes to be announced. */}
      <span aria-live="polite" className="sr-only">{announcement}</span>
    </>
  );
}
