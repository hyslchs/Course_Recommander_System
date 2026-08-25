import { configure } from "@testing-library/react";

/**
 * testing-library's default `waitFor`/`findBy*` timeout is 1000ms. That was fine
 * at 19 test files; at 26 the workers contend for CPU and a render chain that
 * normally settles in milliseconds can overshoot 1s, so tests fail in the full
 * run while passing every time their file runs alone.
 *
 * This is a load allowance, not a correctness fix — it only changes how long a
 * genuine hang takes to report. The two actually-broken tests found alongside it
 * (a mock that kept one resolver for a query that fires more than once, and a
 * pagination assertion whose wait condition was also true mid-load) were fixed
 * at the source rather than papered over with this.
 */
configure({ asyncUtilTimeout: 3000 });

/**
 * jsdom gaps that HeroUI/React Aria components hit at import time.
 *
 * `ResizeObserver` is used by HeroUI's `useMeasuredHeight`, which every `Toast`
 * mounts. jsdom still ships no implementation, so without this the toast tests
 * throw before rendering. The stub is deliberately inert — nothing under test
 * asserts on measured heights.
 */
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

/**
 * jsdom ships no `IntersectionObserver` either, and `motion/react`'s `useInView`
 * — used by `NumberTicker` to hold the count until the element is on screen —
 * constructs one in a passive effect. Without this the /explore and /data suites
 * throw at mount.
 *
 * The stub reports "intersecting" once, asynchronously, rather than staying
 * inert: jsdom has no layout, so an honest observer would never fire and the
 * ticker would sit at 0 forever, turning "0 門結果" into an assertion that
 * describes a jsdom artifact instead of the product. Firing once is what a real
 * browser does for an element that is already in the viewport, which is where
 * both ticker call sites are.
 */
if (!("IntersectionObserver" in globalThis)) {
  class IntersectionObserverStub {
    readonly root = null;
    readonly rootMargin = "0px";
    readonly thresholds: readonly number[] = [0];
    #callback: (entries: unknown[], observer: unknown) => void;
    constructor(callback: (entries: unknown[], observer: unknown) => void) {
      this.#callback = callback;
    }
    observe(target: Element) {
      queueMicrotask(() => {
        this.#callback([{ intersectionRatio: 1, isIntersecting: true, target }], this);
      });
    }
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  }
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IntersectionObserverStub;
}

/**
 * jsdom 30 still ships no `window.matchMedia`. HeroUI's `Toast.Provider` calls
 * it during render to decide whether the action button belongs inside the
 * content column (its mobile layout). Reporting "no match" keeps the desktop
 * layout, which is what the assertions describe.
 */
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    addEventListener: () => {},
    addListener: () => {},
    dispatchEvent: () => false,
    matches: false,
    media: query,
    onchange: null,
    removeEventListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
}
