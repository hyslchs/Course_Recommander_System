import type { ReactNode } from "react";
import { motion } from "motion/react";
import { useReducedMotion } from "@/hooks/useReducedMotion";

/**
 * Highest stagger step. Result 7 and result 30 share the same delay.
 *
 * Plan §4.6: an uncapped 40ms step would make the 30th recommendation wait
 * 1.2 s, which is not an entrance any more, it is a queue. Capped, the whole
 * grid has finished within 240 ms + 220 ms.
 */
export const BLUR_FADE_MAX_STAGGER_INDEX = 6;
/** Plan §4.6 tuning: 0.22s / 3px travel / 4px blur. */
export const BLUR_FADE_DURATION = 0.22;
export const BLUR_FADE_OFFSET = 3;
export const BLUR_FADE_BLUR = "4px";
export const BLUR_FADE_STAGGER_STEP = 0.04;

export function blurFadeDelay(index: number): number {
  return Math.min(Math.max(index, 0), BLUR_FADE_MAX_STAGGER_INDEX) * BLUR_FADE_STAGGER_STEP;
}

export interface BlurFadeProps {
  children: ReactNode;
  /** Position in the list. Clamped to `BLUR_FADE_MAX_STAGGER_INDEX`. */
  index?: number;
  className?: string;
}

function BlurFadeMotion({ children, index = 0, className }: BlurFadeProps) {
  return (
    <motion.div
      animate={{ filter: "blur(0px)", opacity: 1, y: 0 }}
      className={className}
      initial={{ filter: `blur(${BLUR_FADE_BLUR})`, opacity: 0, y: BLUR_FADE_OFFSET }}
      transition={{ delay: blurFadeDelay(index), duration: BLUR_FADE_DURATION, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Entrance for recommendation result cards. Adapted from Magic UI `blur-fade`.
 *
 * WHAT CHANGED FROM THE REGISTRY SOURCE, and why each change was necessary:
 *
 * 1. Vendored by hand. The registry installs through `npx shadcn`, which this
 *    repo does not use, and its source imports `cn` from `@/lib/utils`, which
 *    does not exist here. Nothing else consumes `cn`, so the prop is a plain
 *    `className` pass-through instead.
 * 2. `AnimatePresence` dropped. It only earns its keep for exit animations, and
 *    these cards have none: a new search replaces the whole grid, and animating
 *    30 cards out before animating 30 in is the opposite of responsive.
 * 3. The `direction` / `variant` / `inViewMargin` knobs are gone. One caller,
 *    one behaviour; §4.6 asks for restraint, and unused configuration is where
 *    inconsistency comes from.
 * 4. NO VIEWPORT GATING — deliberate, and the registry default agrees. Upstream
 *    ships `inView = false`, and `isInView = !inView || inViewResult` means that
 *    default is "animate on mount", not "wait to be scrolled into view". Kept,
 *    because for these cards viewport-gating would be actively worse:
 *      - the grid is a *response* to a search the user just ran. The
 *        acknowledgement has to happen when the results arrive, not when the
 *        user scrolls to them;
 *      - `ux` rates motion-sensitivity High and specifically calls out motion
 *        bound to scrolling. On-mount motion happens once, on the user's own
 *        action; scroll-triggered motion happens whenever they move;
 *      - it would make the stagger cap meaningless. Cards 7+ all share the
 *        240 ms delay because the grid animates as one thing; gate them on the
 *        viewport and they instead fire one at a time, forever.
 * 5. Reduced motion skips the wrapper entirely — see `useReducedMotion`. This
 *    is the whole reason the animated half lives in a separate component: React
 *    forbids conditional hooks, so the only way not to run `motion`'s hooks is
 *    not to render the component that calls them.
 */
export function BlurFade({ children, index = 0, className }: BlurFadeProps) {
  const reducedMotion = useReducedMotion();
  if (reducedMotion) return <div className={className}>{children}</div>;
  return <BlurFadeMotion className={className} index={index}>{children}</BlurFadeMotion>;
}
