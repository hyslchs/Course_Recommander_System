/**
 * Recommendation-funnel instrumentation: impression, click, add, skip.
 *
 * The funnel is the point of the whole exercise, and it needs exactly one thing
 * that ordinary event logging does not: a key that ties an impression to the
 * click and the add that followed it. That key is the `interaction_id` of the
 * recommendation *run*, minted when results are produced and thrown away when
 * they leave the screen. It links four events inside one operation and links
 * nothing across operations, which is precisely the boundary §3 draws.
 *
 * `CourseCard` renders on 探索課程 too, where there is no run and no context —
 * so the hooks below no-op there rather than inventing a surface.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { newInteractionId, track, trackWithLegacy, trackV3 } from "./client";
import type { DepartmentRelation, RecommendationMethod, RecommendationRunOutcome } from "./events";

export interface RecommendationSurfaceValue {
  /** The current run. Every funnel event for these results carries it. */
  interactionId: string;
  method: RecommendationMethod;
  /**
   * Called by any engagement (a click, an add). Suppresses the
   * `recommendation_skipped` event for this run — see {@link useRecommendationRun}.
   */
  markEngaged: () => void;
  recordImpression: () => void;
  recordClick: () => void;
  recordAdd: () => void;
  elapsedSinceReady: () => number | undefined;
}

const RecommendationSurfaceContext = createContext<RecommendationSurfaceValue | undefined>(undefined);

export function RecommendationSurface({
  value,
  children,
}: {
  value: RecommendationSurfaceValue | undefined;
  children: ReactNode;
}) {
  return <RecommendationSurfaceContext.Provider value={value}>{children}</RecommendationSurfaceContext.Provider>;
}

/** The enclosing recommendation run, or `undefined` outside one. */
export function useRecommendationSurface(): RecommendationSurfaceValue | undefined {
  return useContext(RecommendationSurfaceContext);
}

/**
 * A ref callback that reports a *real* impression.
 *
 * The recommendation grid renders every result at once, so most of them start
 * below the fold: counting a server response of 20 as 20 impressions would
 * inflate the denominator of every CTR on the dashboard. An `IntersectionObserver`
 * at 50% visibility for 300ms is the honest version — the card has to actually
 * be on screen, and briefly scrolling past it does not count.
 *
 * Fires at most once per (run, course). Where `IntersectionObserver` is missing
 * the hook records nothing at all, rather than guessing.
 */
export function useRecommendationImpression(courseId: string, position: number, relation: DepartmentRelation = "unknown") {
  const surface = useRecommendationSurface();
  const [node, setNode] = useState<HTMLElement | null>(null);
  const interactionId = surface?.interactionId;
  const method = surface?.method;

  useEffect(() => {
    if (!node || !interactionId || !method) return;
    if (typeof IntersectionObserver !== "function") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        if (!visible) {
          if (timer !== undefined) clearTimeout(timer);
          timer = undefined;
          return;
        }
        if (timer !== undefined) return;
        timer = setTimeout(() => {
          observer.disconnect();
          trackWithLegacy(
            "recommendation_impression",
            { course_id: courseId, position, method, department_relation: relation },
            { course_id: courseId, position, method },
            { interactionId },
          );
          surface?.recordImpression();
        }, 300);
      },
      { threshold: 0.5 },
    );
    observer.observe(node);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      observer.disconnect();
    };
  }, [courseId, interactionId, method, node, position, relation, surface]);

  return setNode;
}

/**
 * Records a click on a recommended course and marks the run as engaged.
 *
 * "Click" is defined as *opening* a result: expanding its syllabus panel or
 * following it to the official outline. Hovering, favouriting and dismissing are
 * not clicks — they are their own `feature_clicked` events, and folding them
 * into CTR would make the number mean nothing in particular.
 */
export function useRecommendationClick(courseId: string, position: number | undefined, relation: DepartmentRelation = "unknown") {
  const surface = useRecommendationSurface();
  const clicked = useRef("");
  return useCallback(() => {
    if (!surface || !position) return;
    const key = `${surface.interactionId}:${courseId}`;
    if (clicked.current === key) return;
    clicked.current = key;
    surface.markEngaged();
    surface.recordClick();
    const elapsedMs = surface.elapsedSinceReady();
    const enhanced = {
      course_id: courseId,
      position,
      method: surface.method,
      department_relation: relation,
      ...(elapsedMs === undefined ? {} : { elapsed_ms: elapsedMs, elapsed_origin: "recommendation_result" as const }),
    };
    trackWithLegacy(
      "recommendation_clicked",
      enhanced,
      { course_id: courseId, position, method: surface.method },
      { interactionId: surface.interactionId },
    );
  }, [courseId, position, relation, surface]);
}

export interface RecommendationRun {
  /** Pass to {@link RecommendationSurface}. `undefined` until the first run. */
  surface: RecommendationSurfaceValue | undefined;
  /** Opens a new run, closing the previous one. Returns the new interaction id. */
  start: (pendingOutcome?: RecommendationRunOutcome) => string;
  /** How many results the current run put on screen. Safe to call repeatedly. */
  settle: (resultCount: number) => void;
  /** Completes the current run exactly once, including zero/error outcomes. */
  complete: (outcome?: RecommendationRunOutcome) => void;
}

/**
 * Owns one recommendation surface's run lifecycle, including the `skipped` rule.
 *
 * A run counts as skipped when results were shown, the student engaged with none
 * of them, and the run then ended — by a new search, or by leaving the page.
 * That is a real signal ("these results were not worth touching") and it is
 * decidable from state this hook already holds.
 *
 * It deliberately does *not* fire on re-render: the closing happens in `start`
 * and in the unmount cleanup, both of which run exactly once per run. A filter
 * change re-ranks the same run and re-`settle`s the count; it does not end it.
 */
export function useRecommendationRun(method: RecommendationMethod): RecommendationRun {
  const [interactionId, setInteractionId] = useState("");
  const active = useRef<{
    id: string;
    resultCount: number;
    impressionCount: number;
    clickCount: number;
    addCount: number;
    resultReadyAt?: number;
    pending: boolean;
  } | undefined>(undefined);

  const closeCurrentRun = useCallback((forcedOutcome?: RecommendationRunOutcome) => {
    const run = active.current;
    active.current = undefined;
    if (!run) {
      setInteractionId("");
      return;
    }
    setInteractionId("");
    const outcome = forcedOutcome ?? (run.pending ? "abandoned" : run.resultCount > 0 ? "results" : "zero_result");
    trackV3(
      "recommendation_run_completed",
      {
        method,
        result_count: run.resultCount,
        impression_count: run.impressionCount,
        click_count: run.clickCount,
        add_count: run.addCount,
        outcome,
      },
      { interactionId: run.id },
    );
    if (outcome === "results" && run.resultCount > 0 && run.clickCount === 0 && run.addCount === 0) {
      track("recommendation_skipped", { result_count: run.resultCount, method }, { interactionId: run.id });
    }
  }, [method]);

  // The cleanup closes the last run when the page unmounts. `closeCurrentRun` is
  // stable for a given `method`, so this does not re-run on every render.
  useEffect(() => closeCurrentRun, [closeCurrentRun]);

  const start = useCallback((pendingOutcome?: RecommendationRunOutcome) => {
    closeCurrentRun(pendingOutcome);
    const id = newInteractionId("rec");
    active.current = { id, resultCount: 0, impressionCount: 0, clickCount: 0, addCount: 0, pending: true };
    setInteractionId(id);
    return id;
  }, [closeCurrentRun]);

  const settle = useCallback((resultCount: number) => {
    if (active.current) {
      active.current.resultCount = resultCount;
      active.current.pending = false;
      if (resultCount >= 0 && active.current.resultReadyAt === undefined) active.current.resultReadyAt = performance.now();
    }
  }, []);

  const markEngaged = useCallback(() => {
    // Kept as a stable compatibility callback for existing surfaces. Run
    // engagement is now derived from the explicit click/add counters.
  }, []);

  const recordImpression = useCallback(() => {
    if (active.current) active.current.impressionCount += 1;
  }, []);

  const recordClick = useCallback(() => {
    if (active.current) active.current.clickCount += 1;
  }, []);

  const recordAdd = useCallback(() => {
    if (active.current) active.current.addCount += 1;
  }, []);

  const elapsedSinceReady = useCallback(() => {
    const readyAt = active.current?.resultReadyAt;
    if (readyAt === undefined) return undefined;
    const elapsed = Math.round(performance.now() - readyAt);
    return elapsed >= 0 && elapsed <= 7_200_000 ? elapsed : undefined;
  }, []);

  const surface = useMemo<RecommendationSurfaceValue | undefined>(
    () => (interactionId ? { interactionId, method, markEngaged, recordImpression, recordClick, recordAdd, elapsedSinceReady } : undefined),
    [elapsedSinceReady, interactionId, markEngaged, method, recordAdd, recordClick, recordImpression],
  );

  // Memoised, and load-bearing: `RecommendPage` lists its re-rank callback in an
  // effect's dependency array, so a fresh object every render would re-run the
  // effect, set state, and re-render — forever.
  const complete = useCallback((outcome?: RecommendationRunOutcome) => closeCurrentRun(outcome), [closeCurrentRun]);
  return useMemo(() => ({ surface, start, settle, complete }), [complete, settle, start, surface]);
}
