/**
 * Search *flows*, for the refinement metric.
 *
 * A flow is a run of searches close enough together in time to be read as one
 * person narrowing one intent (「AI」→「生成式 AI」→「生成式 AI Python」). Each
 * search inside a flow gets a `refinement_index`; index 0 is the flow's first
 * search and emits no `search_refined` event.
 *
 * WHY TIME, AND NOT SOMETHING SMARTER. The obvious alternative — comparing the
 * new query with the previous one to see whether it is an extension of it —
 * requires holding the previous query text, which is the one thing analytics is
 * not allowed to hold. A gap timer needs nothing but a clock, keeps no text, and
 * answers the question actually being asked ("how many attempts does a search
 * take?").
 *
 * WHAT IT CANNOT DO, stated so the dashboard number is read correctly: it cannot
 * tell a refinement from an unrelated second search inside the window, and on
 * 探索課程 — where the query runs on a 300 ms debounce rather than a submit
 * button — a single typed phrase can settle more than once and count as more
 * than one attempt. The number is an upper bound on refinements, not an exact
 * count. See the report's "尚未完成/限制" section.
 */

import { newInteractionId } from "./client";

/** Silence longer than this starts a new flow. */
export const SEARCH_FLOW_GAP_MS = 90_000;

export interface SearchFlowState {
  flowId: string;
  /** 0 for the first search of a flow, 1 for the first refinement, and so on. */
  refinementIndex: number;
  lastSearchAt: number;
}

/**
 * Advance a flow by one search. Pure, so the rule is testable without a clock or
 * a component.
 */
export function nextSearchStep(
  previous: SearchFlowState | undefined,
  now: number,
  gapMs: number = SEARCH_FLOW_GAP_MS,
): SearchFlowState {
  if (previous && now - previous.lastSearchAt <= gapMs) {
    return {
      flowId: previous.flowId,
      // The server caps `refinement_index` at 100; stop counting rather than
      // emitting events it will reject.
      refinementIndex: Math.min(previous.refinementIndex + 1, 100),
      lastSearchAt: now,
    };
  }
  return { flowId: newInteractionId("flow"), refinementIndex: 0, lastSearchAt: now };
}
