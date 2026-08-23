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
