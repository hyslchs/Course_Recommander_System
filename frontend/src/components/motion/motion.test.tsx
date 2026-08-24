import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BlurFade, BLUR_FADE_MAX_STAGGER_INDEX, blurFadeDelay } from "./BlurFade";
import { NumberTicker } from "./NumberTicker";

const originalMatchMedia = window.matchMedia;

function setReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    addEventListener: () => {},
    addListener: () => {},
    dispatchEvent: () => false,
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    removeEventListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => { window.matchMedia = originalMatchMedia; });

describe("BlurFade stagger", () => {
  /**
   * Plan §4.6 caps the stagger index at 6. Uncapped, a 30-result grid would
   * take 1.2s to finish arriving; capped it is 240ms however many came back.
   */
  it("clamps the delay at the sixth card", () => {
    expect(blurFadeDelay(0)).toBe(0);
    expect(blurFadeDelay(3)).toBeCloseTo(0.12);
    expect(blurFadeDelay(BLUR_FADE_MAX_STAGGER_INDEX)).toBeCloseTo(0.24);
    expect(blurFadeDelay(7)).toBe(blurFadeDelay(BLUR_FADE_MAX_STAGGER_INDEX));
    expect(blurFadeDelay(29)).toBe(blurFadeDelay(BLUR_FADE_MAX_STAGGER_INDEX));
    // Defensive: a negative index would otherwise produce a negative delay.
    expect(blurFadeDelay(-4)).toBe(0);
  });

  it("renders the children either way", async () => {
    setReducedMotion(false);
    render(<BlurFade index={2}><p>結果卡片</p></BlurFade>);
    expect(await screen.findByText("結果卡片")).toBeInTheDocument();
  });
});

describe("prefers-reduced-motion bypass", () => {
  /**
   * The point of the whole `useReducedMotion` layer: `motion/react` animates by
   * writing inline styles frame by frame, so the global CSS kill switch has
   * nothing to override. The wrapper must not be MOUNTED, not merely be given a
   * zero duration — which is what these two assertions distinguish.
   */
  it("renders BlurFade as a plain div with no motion styles", () => {
    setReducedMotion(true);
    const { container } = render(<BlurFade className="result-reveal" index={4}><p>卡片</p></BlurFade>);
    const wrapper = container.querySelector(".result-reveal") as HTMLElement;
    expect(wrapper.tagName).toBe("DIV");
    // motion.div commits `opacity`/`transform`/`filter` inline on first paint.
    expect(wrapper.style.opacity).toBe("");
    expect(wrapper.style.transform).toBe("");
    expect(wrapper.style.filter).toBe("");
  });

  it("mounts motion styles when motion is allowed", async () => {
    setReducedMotion(false);
    const { container } = render(<BlurFade className="result-reveal" index={4}><p>卡片</p></BlurFade>);
    const wrapper = container.querySelector(".result-reveal") as HTMLElement;
    await waitFor(() => expect(wrapper.style.opacity).not.toBe(""));
  });

  it("renders NumberTicker as its final value, with no spring", () => {
    setReducedMotion(true);
    const { container } = render(<NumberTicker value={1234} />);
    // One span, not two: the sr-only twin only exists to hold the true value
    // while the spring is mid-flight, and there is no spring on this path.
    const spans = [...container.querySelectorAll("span")];
    expect(spans.map((node) => node.textContent)).toEqual(["1,234"]);
    expect(spans[0]).not.toHaveAttribute("aria-hidden");
  });

  it("starts NumberTicker at zero and settles on the value when motion is allowed", async () => {
    setReducedMotion(false);
    const { container } = render(<NumberTicker value={1234} />);
    const visible = container.querySelector("span") as HTMLElement;
    expect(visible).toHaveAttribute("aria-hidden", "true");
    expect(visible.textContent).toBe("0");
    await waitFor(() => expect(visible.textContent).not.toBe("0"), { timeout: 3000 });
  });
});

describe("NumberTicker formatting", () => {
  it("formats in zh-Hant-TW, not en-US, and forces no colour of its own", () => {
    setReducedMotion(true);
    const { container } = render(<NumberTicker value={98765} />);
    const visible = container.querySelector("span") as HTMLElement;
    expect(visible.textContent).toBe(Intl.NumberFormat("zh-Hant-TW").format(98765));
    // The registry source hard-codes `text-black … dark:text-white`; both would
    // break §4.2 at the two call sites, which already carry a themed colour.
    expect(visible.className).toBe("");
  });

  it("keeps the true total in the accessibility tree while the spring runs", () => {
    setReducedMotion(false);
    const { container } = render(<NumberTicker value={4321} />);
    const [visible, screenReaderCopy] = [...container.querySelectorAll("span")];
    expect(visible).toHaveAttribute("aria-hidden", "true");
    expect(screenReaderCopy).toHaveClass("sr-only");
    expect(screenReaderCopy.textContent).toBe("4,321");
  });
});
