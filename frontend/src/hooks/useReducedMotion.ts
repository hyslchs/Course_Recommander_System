import { useCallback, useSyncExternalStore } from "react";

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Layer 2 of the plan's three-layer `prefers-reduced-motion` strategy (§4.6).
 *
 * WHY THIS EXISTS AT ALL, given that `styles.css` already carries a global
 * `@media (prefers-reduced-motion: reduce)` kill switch: that switch sets
 * `animation-duration` and `transition-duration`, which are CSS properties.
 * Nothing in this app's motion layer is a CSS animation:
 *
 *   - `NumberTicker` runs a `motion/react` spring. Springs have no CSS duration
 *     to override; `useSpring` integrates in `requestAnimationFrame` and writes
 *     `textContent`. `!important` cannot reach it.
 *   - `BlurFade` renders `motion.div`, which animates by writing inline styles
 *     frame by frame. An `!important` transition-duration does not apply,
 *     because there is no transition — the value is simply different each frame.
 *   - `ThemeToggle` drives its reveal with `Element.animate()`, a Web Animations
 *     API call whose duration comes from a JS options object, not the cascade.
 *
 * So the hook does not *slow* those down, it decides whether they are mounted at
 * all. Each wrapper calls this first and returns plain markup when it is true,
 * leaving the `motion` hooks in a child component that is never rendered.
 *
 * `useSyncExternalStore` rather than `useEffect` so the very first render
 * already knows the answer — an effect would mount the animated branch for one
 * commit and then unmount it, which is one frame of exactly the motion the user
 * asked not to see.
 */
export function useReducedMotion(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
    const list = window.matchMedia(REDUCED_MOTION_QUERY);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, []);
  const getSnapshot = useCallback(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(REDUCED_MOTION_QUERY).matches;
  }, []);
  // Server snapshot: assume motion is fine, then correct on hydration. This app
  // never renders on a server, so the third argument only satisfies the type.
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
