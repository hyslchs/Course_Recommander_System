import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getRecord, putRecord } from "@/data/db";

export const THEME_LIGHT = "fju";
export const THEME_DARK = "fju-dark";

export type ThemeName = typeof THEME_LIGHT | typeof THEME_DARK;

/** Row id inside the `preferences` store. */
export const THEME_RECORD_ID = "theme";

/**
 * Paint-time mirror of the IndexedDB preference.
 *
 * IndexedDB is the store of record (plan T40), but every read from it is async,
 * so it cannot answer "which theme?" before the first paint. `localStorage` is
 * synchronous, so the inline `<script>` in `index.html` reads THIS key to set
 * `data-theme` while the parser is still in `<head>` — before the render-blocking
 * stylesheet has even been requested, therefore before any pixel exists.
 *
 * THE TRADE-OFF, stated plainly: two stores can disagree. IndexedDB wins.
 * `ThemeProvider` reads it on mount and re-syncs the mirror, so the only way to
 * see a wrong theme is to clear `localStorage` without clearing IndexedDB, and
 * even then it is one corrective flip on one load rather than a flash on every
 * load. The alternative — awaiting IndexedDB before painting — guarantees the
 * flash for everybody, and is what this exists to avoid.
 *
 * Keep this string identical to the one in `frontend/index.html`.
 */
export const THEME_STORAGE_KEY = "fju-theme";

export const COLOR_SCHEME_DARK_QUERY = "(prefers-color-scheme: dark)";

export function isThemeName(value: unknown): value is ThemeName {
  return value === THEME_LIGHT || value === THEME_DARK;
}

/** The theme the OS asks for. Used only until the user makes a choice. */
export function systemTheme(): ThemeName {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return THEME_LIGHT;
  return window.matchMedia(COLOR_SCHEME_DARK_QUERY).matches ? THEME_DARK : THEME_LIGHT;
}

/**
 * The theme currently on the document.
 *
 * This is the provider's initial state on purpose: the inline script already
 * resolved it, so React starts in agreement with the painted DOM and no effect
 * has to correct it.
 */
export function documentTheme(): ThemeName {
  if (typeof document === "undefined") return THEME_LIGHT;
  const painted = document.documentElement.dataset.theme;
  return isThemeName(painted) ? painted : systemTheme();
}

/**
 * The one place the theme reaches the DOM. Attribute, never `classList`:
 * `styles.css` declares `@custom-variant dark (&:where([data-theme="fju-dark"], …))`
 * and `theme/fju.css` keys every token off `[data-theme="fju"|"fju-dark"]`, so a
 * `.dark` class would be a second, silently disagreeing source of truth.
 */
export function applyThemeAttribute(theme: ThemeName): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
}

function writeMirror(theme: ThemeName | null): void {
  try {
    if (theme === null) window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private mode / storage disabled. IndexedDB still has the preference; the
    // user just pays one flash per load.
  }
}

interface ThemeRecord {
  id: typeof THEME_RECORD_ID;
  theme: ThemeName;
}

export interface ThemeContextValue {
  theme: ThemeName;
  isDark: boolean;
  setTheme: (theme: ThemeName) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

/**
 * Owns the theme: resolves it, applies it, persists it.
 *
 * Precedence is (1) the user's explicit choice, forever, (2) the OS
 * `prefers-color-scheme`, live. Point 2 keeps working after mount — a user who
 * has never touched the toggle follows their OS switching at dusk — and stops
 * the moment they choose, which is what "an explicit choice wins afterwards"
 * means.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>(documentTheme);
  // A ref, not state: the OS listener below must read the *current* value
  // without being torn down and rebuilt on every choice.
  const hasExplicitChoice = useRef(false);

  const setTheme = useCallback((next: ThemeName) => {
    hasExplicitChoice.current = true;
    applyThemeAttribute(next);
    writeMirror(next);
    setThemeState(next);
    void putRecord<ThemeRecord>("preferences", { id: THEME_RECORD_ID, theme: next });
  }, []);

  // Reconcile with the store of record. The inline script has already painted
  // from the mirror, so this normally confirms what is on screen and does
  // nothing visible.
  useEffect(() => {
    let subscribed = true;
    void (async () => {
      try {
        const record = await getRecord<ThemeRecord>("preferences", THEME_RECORD_ID);
        if (!subscribed || !record || !isThemeName(record.theme)) return;
        hasExplicitChoice.current = true;
        applyThemeAttribute(record.theme);
        writeMirror(record.theme);
        setThemeState(record.theme);
      } catch {
        // No IndexedDB (private mode, quota): the mirror and the OS still work.
      }
    })();
    return () => { subscribed = false; };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(COLOR_SCHEME_DARK_QUERY);
    const onChange = () => {
      if (hasExplicitChoice.current) return;
      const next = list.matches ? THEME_DARK : THEME_LIGHT;
      applyThemeAttribute(next);
      setThemeState(next);
    };
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ isDark: theme === THEME_DARK, setTheme, theme }),
    [theme, setTheme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Falls back to reading the DOM when no provider is mounted, so the several
 * tests that render a page bare (a deliberate property of this codebase, see
 * task 01) keep working.
 */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  const fallback = useMemo<ThemeContextValue>(() => {
    const current = documentTheme();
    return { isDark: current === THEME_DARK, setTheme: applyThemeAttribute, theme: current };
  }, []);
  return context ?? fallback;
}
