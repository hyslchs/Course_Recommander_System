import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "@/components/motion/ThemeToggle";
import {
  documentTheme,
  systemTheme,
  ThemeProvider,
  THEME_DARK,
  THEME_LIGHT,
  THEME_RECORD_ID,
  THEME_STORAGE_KEY,
} from "./theme";

/**
 * The narrowest in-memory IndexedDB that `getRecord` / `putRecord` touch:
 * `open` (with `onupgradeneeded` then `onsuccess`), `transaction`, and the
 * `get` / `put` requests. Callbacks fire on a later task, as the real one does.
 * `db.test.ts` carries a fuller version for the batching tests; duplicating the
 * three methods needed here is cheaper than exporting a harness between suites.
 *
 * Installed ONCE, at module scope, and emptied between tests. `db.ts` memoises
 * its `openDatabase()` promise, so swapping the fake per test would leave the
 * first one connected; and `vi.resetModules()` cannot be used to get around
 * that here, because a re-imported `theme.tsx` would build a second React
 * context that the statically-imported `ThemeToggle` does not consume — the
 * provider would silently stop reaching it.
 */
const stores = new Map<string, Map<string, { id: string }>>();

function installFakeIndexedDB(): void {
  const later = (run: () => void) => setTimeout(run, 0);
  const rowsOf = (name: string) => {
    const rows = stores.get(name) ?? new Map<string, { id: string }>();
    stores.set(name, rows);
    return rows;
  };
  const request = <T,>(compute: () => T) => {
    const handle: { onsuccess: (() => void) | null; onerror: (() => void) | null; result: T | undefined; error: null } =
      { error: null, onerror: null, onsuccess: null, result: undefined };
    later(() => { handle.result = compute(); handle.onsuccess?.(); });
    return handle;
  };
  const database = {
    createObjectStore: (name: string) => stores.set(name, new Map()),
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    transaction(names: string | string[]) {
      const scope = Array.isArray(names) ? names : [names];
      const pending: (() => void)[] = [];
      const transaction: {
        objectStore: (name: string) => unknown;
        oncomplete: (() => void) | null;
        onerror: (() => void) | null;
        onabort: (() => void) | null;
        error: null;
        abort: () => void;
      } = {
        abort: () => {},
        error: null,
        objectStore: (name: string) => {
          if (!scope.includes(name)) throw new Error(`store ${name} is outside this transaction's scope`);
          const rows = rowsOf(name);
          return {
            get: (id: string) => request(() => rows.get(id)),
            put: (value: { id: string }) => pending.push(() => rows.set(value.id, value)),
          };
        },
        onabort: null,
        oncomplete: null,
        onerror: null,
      };
      later(() => { for (const apply of pending) apply(); transaction.oncomplete?.(); });
      return transaction;
    },
  };
  (globalThis as unknown as { indexedDB: unknown }).indexedDB = {
    open: () => {
      const handle: {
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onupgradeneeded: (() => void) | null;
        result: typeof database;
        error: null;
      } = { error: null, onerror: null, onsuccess: null, onupgradeneeded: null, result: database };
      later(() => { handle.onupgradeneeded?.(); handle.onsuccess?.(); });
      return handle;
    },
  };
}

installFakeIndexedDB();

function stubMatchMedia(matches: (query: string) => boolean) {
  window.matchMedia = ((query: string) => ({
    addEventListener: () => {},
    addListener: () => {},
    dispatchEvent: () => false,
    matches: matches(query),
    media: query,
    onchange: null,
    removeEventListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

const originalMatchMedia = window.matchMedia;

/**
 * `Document.startViewTransition` is declared non-optional by the DOM lib, so it
 * cannot be assigned or `delete`d through a cast. jsdom does not implement it,
 * which is exactly the condition under test.
 */
function setStartViewTransition(implementation: unknown): void {
  Object.defineProperty(document, "startViewTransition", {
    configurable: true, value: implementation, writable: true,
  });
}

describe("theme preference", () => {
  beforeEach(() => {
    for (const rows of stores.values()) rows.clear();
    window.localStorage.clear();
    document.documentElement.dataset.theme = THEME_LIGHT;
    document.documentElement.classList.remove("dark");
    stubMatchMedia(() => false);
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    Reflect.deleteProperty(document, "startViewTransition");
    document.documentElement.dataset.theme = THEME_LIGHT;
  });

  it("round-trips the choice through IndexedDB and the paint-time mirror", async () => {
    const first = render(<ThemeProvider><ThemeToggle /></ThemeProvider>);
    await userEvent.click(screen.getByRole("button", { name: "切換為深色模式" }));

    await waitFor(() => expect(stores.get("preferences")?.get(THEME_RECORD_ID)).toEqual({
      id: THEME_RECORD_ID, theme: THEME_DARK,
    }));
    // The synchronous mirror the inline <head> script reads on the next load.
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(THEME_DARK);

    // …and a fresh mount with the mirror wiped still comes back dark, from
    // IndexedDB alone. That is the half of the round trip that proves IndexedDB,
    // not localStorage, is the store of record.
    first.unmount();
    window.localStorage.clear();
    document.documentElement.dataset.theme = THEME_LIGHT;
    render(<ThemeProvider><ThemeToggle /></ThemeProvider>);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe(THEME_DARK));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(THEME_DARK);
  });

  /**
   * The single most important regression in this task. Magic UI's
   * `animated-theme-toggler` calls `classList.toggle("dark")` unconditionally,
   * even in controlled mode. This project themes with `data-theme` only, so a
   * class would be a second source of truth that disagrees on every toggle.
   */
  it("writes data-theme and never touches the dark class", async () => {
    render(<ThemeProvider><ThemeToggle /></ThemeProvider>);

    await userEvent.click(screen.getByRole("button", { name: "切換為深色模式" }));
    expect(document.documentElement.dataset.theme).toBe(THEME_DARK);
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    await userEvent.click(await screen.findByRole("button", { name: "切換為淺色模式" }));
    expect(document.documentElement.dataset.theme).toBe(THEME_LIGHT);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("announces the resulting state, not just the action", async () => {
    const { container } = render(<ThemeProvider><ThemeToggle /></ThemeProvider>);
    const live = container.querySelector("[aria-live='polite']") as HTMLElement;
    // Rendered empty from the first paint: a live region has to already exist
    // for a later change to it to be announced.
    expect(live.textContent).toBe("");

    await userEvent.click(screen.getByRole("button", { name: "切換為深色模式" }));
    expect(live).toHaveTextContent("已切換為深色模式");
    await userEvent.click(await screen.findByRole("button", { name: "切換為淺色模式" }));
    expect(live).toHaveTextContent("已切換為淺色模式");
  });

  it("starts from prefers-color-scheme when nothing was ever chosen", () => {
    stubMatchMedia((query) => query.includes("prefers-color-scheme: dark"));
    delete document.documentElement.dataset.theme;
    expect(systemTheme()).toBe(THEME_DARK);
    // No painted attribute and no stored choice: fall through to the OS.
    expect(documentTheme()).toBe(THEME_DARK);
  });

  it("lets an explicit choice beat the OS preference", async () => {
    stubMatchMedia((query) => query.includes("prefers-color-scheme: dark"));
    delete document.documentElement.dataset.theme;

    render(<ThemeProvider><ThemeToggle /></ThemeProvider>);
    // The OS says dark, so the toggle offers the light switch.
    await userEvent.click(await screen.findByRole("button", { name: "切換為淺色模式" }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe(THEME_LIGHT));
    await waitFor(() => expect(stores.get("preferences")?.get(THEME_RECORD_ID)).toEqual({
      id: THEME_RECORD_ID, theme: THEME_LIGHT,
    }));
  });

  it("skips the view transition when the user asked for reduced motion", async () => {
    stubMatchMedia((query) => query.includes("prefers-reduced-motion"));
    const startViewTransition = vi.fn();
    setStartViewTransition(startViewTransition);

    render(<ThemeProvider><ThemeToggle /></ThemeProvider>);
    await userEvent.click(screen.getByRole("button", { name: "切換為深色模式" }));

    // The reveal is `Element.animate()`, whose duration is a JS number: the CSS
    // kill switch cannot slow it down, so not calling it is the only real fix.
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.theme).toBe(THEME_DARK);
  });

  it("uses the view transition when motion is allowed", async () => {
    const startViewTransition = vi.fn((callback: () => void) => { act(callback); return {}; });
    setStartViewTransition(startViewTransition);

    render(<ThemeProvider><ThemeToggle /></ThemeProvider>);
    await userEvent.click(screen.getByRole("button", { name: "切換為深色模式" }));

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.theme).toBe(THEME_DARK);
  });
});
