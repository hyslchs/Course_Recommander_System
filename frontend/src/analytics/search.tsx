/** Search-result funnel instrumentation for the Explore page.
 *
 * A result-set interaction id is scoped to one query/filter/page response.
 * It is not a user id and is never persisted. The same id is available to
 * desktop rows, mobile cards, and the add action so the funnel survives the
 * responsive layout switch without joining on course identity alone.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { trackV3 } from "./client";
import type { SearchMode } from "./events";

export interface SearchSurfaceValue {
  interactionId: string;
  searchMode: SearchMode;
  recordImpression: () => void;
  recordClick: () => void;
  elapsedSinceReady: () => number | undefined;
}

const SearchSurfaceContext = createContext<SearchSurfaceValue | undefined>(undefined);

export function SearchSurface({ value, children }: { value: SearchSurfaceValue | undefined; children: ReactNode }) {
  return <SearchSurfaceContext.Provider value={value}>{children}</SearchSurfaceContext.Provider>;
}

export function useSearchSurface(): SearchSurfaceValue | undefined {
  return useContext(SearchSurfaceContext);
}

export function useSearchResultImpression(courseId: string, position: number | undefined) {
  const surface = useSearchSurface();
  const [node, setNode] = useState<HTMLElement | null>(null);
  const interactionId = surface?.interactionId;
  const searchMode = surface?.searchMode;

  useEffect(() => {
    if (!node || !interactionId || !searchMode || !position) return;
    if (typeof IntersectionObserver !== "function") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        return;
      }
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        observer.disconnect();
        trackV3("search_result_impression", { course_id: courseId, position, search_mode: searchMode }, { interactionId });
        surface.recordImpression();
      }, 300);
    }, { threshold: 0.5 });
    observer.observe(node);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      observer.disconnect();
    };
  }, [courseId, interactionId, node, position, searchMode, surface]);

  return setNode;
}

export function useSearchResultClick(courseId: string, position: number | undefined) {
  const surface = useSearchSurface();
  const clicked = useRef("");
  return useCallback(() => {
    if (!surface || !position) return;
    const key = `${surface.interactionId}:${courseId}`;
    if (clicked.current === key) return;
    clicked.current = key;
    const elapsedMs = surface.elapsedSinceReady();
    trackV3(
      "search_result_clicked",
      {
        course_id: courseId,
        position,
        search_mode: surface.searchMode,
        ...(elapsedMs === undefined ? {} : { elapsed_ms: elapsedMs, elapsed_origin: "search_result" as const }),
      },
      { interactionId: surface.interactionId },
    );
    surface.recordClick();
  }, [courseId, position, surface]);
}

export function createSearchSurface(interactionId: string, searchMode: SearchMode, readyAt: number): SearchSurfaceValue {
  return {
    interactionId,
    searchMode,
    recordImpression: () => undefined,
    recordClick: () => undefined,
    elapsedSinceReady: () => {
      const elapsed = Math.round(performance.now() - readyAt);
      return elapsed >= 0 && elapsed <= 7_200_000 ? elapsed : undefined;
    },
  };
}

export function useStableSearchSurface(interactionId: string | undefined, searchMode: SearchMode, readyAt: number | undefined) {
  return useMemo(
    () => interactionId && readyAt !== undefined ? createSearchSurface(interactionId, searchMode, readyAt) : undefined,
    [interactionId, readyAt, searchMode],
  );
}
