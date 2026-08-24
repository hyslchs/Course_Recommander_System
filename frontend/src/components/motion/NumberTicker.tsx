import { useEffect, useRef, type ComponentPropsWithoutRef } from "react";
import { useInView, useMotionValue, useSpring } from "motion/react";
import { useReducedMotion } from "@/hooks/useReducedMotion";

/**
 * The app renders zh-Hant-TW throughout, so the counter must too. The registry
 * source hard-codes `Intl.NumberFormat("en-US", …)`, which is a different
 * grouping convention from the `toLocaleString()` calls already on the pages
 * this replaces — "1,234" happens to agree, but the locale being wrong is not
 * something to leave sitting in the source.
 */
export const TICKER_LOCALE = "zh-Hant-TW";

export interface NumberTickerProps extends Omit<ComponentPropsWithoutRef<"span">, "children"> {
  value: number;
  decimalPlaces?: number;
}

function format(value: number, decimalPlaces: number): string {
  return Intl.NumberFormat(TICKER_LOCALE, {
    maximumFractionDigits: decimalPlaces,
    minimumFractionDigits: decimalPlaces,
  }).format(Number(value.toFixed(decimalPlaces)));
}

function NumberTickerMotion({ value, decimalPlaces = 0, className, ...props }: NumberTickerProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const motionValue = useMotionValue(0);
  const springValue = useSpring(motionValue, { damping: 60, stiffness: 100 });
  const isInView = useInView(ref, { margin: "0px", once: true });

  useEffect(() => {
    if (isInView) motionValue.set(value);
  }, [motionValue, isInView, value]);

  useEffect(
    () => springValue.on("change", (latest) => {
      if (ref.current) ref.current.textContent = format(latest, decimalPlaces);
    }),
    [springValue, decimalPlaces],
  );

  // The visible span's text is written imperatively by the spring, so for the
  // ~600ms it is settling it holds a number that is not yet true. Hiding it from
  // assistive tech and pairing it with a static `sr-only` copy means a screen
  // reader always reads the real total, whenever it happens to reach this node.
  return (
    <>
      <span ref={ref} aria-hidden="true" className={className} {...props}>{format(0, decimalPlaces)}</span>
      <span className="sr-only">{format(value, decimalPlaces)}</span>
    </>
  );
}

/**
 * Counts up to `value`. Adapted from Magic UI `number-ticker`.
 *
 * WHAT CHANGED FROM THE REGISTRY SOURCE:
 *
 * 1. Vendored by hand: the registry installs via `npx shadcn` (not used here)
 *    and imports `cn` from `@/lib/utils` (does not exist here).
 * 2. Locale `en-US` -> `zh-Hant-TW`. See `TICKER_LOCALE`.
 * 3. The hard-coded `text-black … dark:text-white` className is gone. The two
 *    call sites are a `<strong>` in the /explore page heading and three `<dd>`
 *    cells on /data, all of which already carry a themed colour; forcing pure
 *    black or pure white there would break the §4.2 palette in BOTH themes.
 *    Inheriting `currentColor` is the only version that is right in both.
 *
 *    (Worth recording precisely, because the received wisdom about this line is
 *    wrong: it is often said that `dark:text-white` cannot fire in this app
 *    since the dark variant keys off `data-theme` rather than a `.dark` class.
 *    It fires. `styles.css` redefines the variant —
 *    `@custom-variant dark (&:where([data-theme="fju-dark"], …))` — precisely so
 *    that `dark:` utilities follow `fju-dark`. Measured in the built CSS. The
 *    class still has to go, just for the reason above rather than that one.)
 * 4. `tabular-nums` dropped rather than kept. Measured in Chrome with the
 *    shipped fonts: every digit in the Latin slice advances the same width
 *    already, and the slice carries no `tnum` feature to switch on, so the
 *    utility emits `font-variant-numeric` that changes nothing. Dead CSS.
 * 5. `startValue` / `direction` / `delay` removed — three knobs, no callers.
 * 6. Reduced motion renders the final number as static text and never mounts
 *    the spring. A CSS kill switch cannot stop `useSpring`: it integrates in
 *    `requestAnimationFrame` and assigns `textContent`. There is no duration in
 *    the cascade to override.
 */
export function NumberTicker({ value, decimalPlaces = 0, className, ...props }: NumberTickerProps) {
  const reducedMotion = useReducedMotion();
  if (reducedMotion) return <span className={className} {...props}>{format(value, decimalPlaces)}</span>;
  return <NumberTickerMotion className={className} decimalPlaces={decimalPlaces} value={value} {...props} />;
}
