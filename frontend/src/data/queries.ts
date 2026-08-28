import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import {
  askCourseAssistant,
  embedQuery,
  embedQueryDetailed,
  getCatalog,
  getClassGroups,
  getCourses,
  getCoursesByIds,
  getDepartmentCatalog,
  getFacets,
  getFeatures,
  getRecommendationAssetState,
  lookupCourses,
  preloadRecommendationAssets,
} from "./api";
import { analyzeQuery } from "@/domain/queryAnalysis";
import type { AIAnswer, AIAskContext, AIHistoryTurn, Course, CourseSummary, HardConstraints } from "@/domain/types";
import type { SearchIndex } from "@/domain/search";
import type { QueryCacheState, RecommendationAssetState } from "./api";

/**
 * Every server read the UI performs, in one place (plan §6.4).
 *
 * Deliberately *not* routed through TanStack Query:
 * - `db.ts` — local mutable user data (profile, plans, backups). It is not a
 *   server cache; `hooks/localData.tsx` owns it.
 * - `getCatalog` / `getEmbeddingBundle` — `api.ts` already content-addresses
 *   those artifacts in IndexedDB by manifest sha256 (`artifactCacheKey`), which
 *   beats an in-memory cache for multi-megabyte payloads. They appear below only
 *   *inside* mutation bodies, where they are awaited but never Query-cached.
 */

export type FacetMap = Record<string, { value: string; label: string }[]>;

export interface CourseQuery {
  q?: string;
  department?: string;
  weekday?: string;
  page: number;
  pageSize: number;
}

export interface ClassGroupQuery {
  department: string;
  division: string;
  grade: number;
}

/** Query keys are hashed structurally, so plain objects and arrays are stable keys. */
export const queryKeys = {
  facets: ["facets"] as const,
  catalog: ["catalog"] as const,
  departmentCatalog: ["department-catalog"] as const,
  features: ["features"] as const,
  classGroups: (params: ClassGroupQuery | null) => ["class-groups", params] as const,
  courses: (params: CourseQuery | null) => ["courses", params] as const,
  coursesByIds: (courseIds: string[]) => ["courses-by-ids", courseIds] as const,
};

/** Reference data that only changes when a new semester is imported. */
const referenceData = { staleTime: Infinity, gcTime: Infinity } as const;

function toSearchParams(query: CourseQuery): URLSearchParams {
  const params = new URLSearchParams({ page: String(query.page), page_size: String(query.pageSize) });
  if (query.q) params.set("q", query.q);
  if (query.department) params.set("department", query.department);
  if (query.weekday) params.set("weekday", query.weekday);
  return params;
}

/** Shared by RecommendPage and ExplorePage; one cache entry means one request. */
export function useFacets() {
  return useQuery({ queryKey: queryKeys.facets, queryFn: () => getFacets(), ...referenceData });
}

/** The full catalogue is loaded only by views that need client-side metadata filtering. */
export function useCatalog(enabled = true) {
  return useQuery({ queryKey: queryKeys.catalog, queryFn: () => getCatalog(), enabled, ...referenceData });
}

export function useDepartmentCatalog() {
  return useQuery({ queryKey: queryKeys.departmentCatalog, queryFn: () => getDepartmentCatalog(), ...referenceData });
}

export function useFeatures() {
  return useQuery({ queryKey: queryKeys.features, queryFn: () => getFeatures(), ...referenceData });
}

/** `null` params disable the query — no department picked yet. */
export function useClassGroups(params: ClassGroupQuery | null) {
  return useQuery({
    queryKey: queryKeys.classGroups(params),
    enabled: params !== null,
    // `getClassGroups` takes an AbortSignal, so Query cancels superseded requests for free.
    queryFn: ({ signal }) => getClassGroups(
      new URLSearchParams({ department: params!.department, division: params!.division, grade: String(params!.grade) }),
      signal,
    ),
  });
}

/**
 * Keeps the previous page/filter result on screen while the next one loads, which
 * is what the hand-rolled `hasLoaded` flag used to do — and Query aborts the
 * superseded request, so a fast filter toggle can no longer surface stale rows.
 */
export function useCourses(params: CourseQuery | null) {
  return useQuery({
    queryKey: queryKeys.courses(params),
    enabled: params !== null,
    queryFn: ({ signal }) => getCourses(toSearchParams(params!), signal),
    placeholderData: keepPreviousData,
  });
}

export function useCoursesByIds(courseIds: string[]) {
  return useQuery({
    queryKey: queryKeys.coursesByIds(courseIds),
    queryFn: () => getCoursesByIds(courseIds),
  });
}

/**
 * Imperative sibling of `useCoursesByIds` for click handlers that need the plan's
 * current courses before deciding whether to write. Shares the cache entry, so the
 * schedule page's copy is refreshed at the same time.
 */
export function useFetchCoursesByIds(): (courseIds: string[]) => Promise<Course[]> {
  const queryClient = useQueryClient();
  return useCallback((courseIds: string[]) => queryClient.fetchQuery({
    queryKey: queryKeys.coursesByIds(courseIds),
    queryFn: () => getCoursesByIds(courseIds),
    staleTime: 0,
  }), [queryClient]);
}

export function useLookupCourses() {
  return useMutation({ mutationFn: (values: string[]) => lookupCourses(values) });
}

export interface RecommendationSources {
  catalog: CourseSummary[];
  courseIds: string[];
  vectors: Float32Array;
  dimension: number;
  query: Float32Array;
  searchIndex: SearchIndex;
  assetWaitMs: number;
  embeddingMs: number;
  assetState: RecommendationAssetState;
  queryCacheState: QueryCacheState;
}

/**
 * The `embedQuery` POST plus the two artifacts it has to be paired with. A
 * mutation, not a query: it is user-initiated and writes nothing to the cache,
 * and only the newest invocation drives the returned state.
 */
export function useRecommendationSources() {
  return useMutation({
    mutationFn: async (subjectQuery: string): Promise<RecommendationSources> => {
      const assetStarted = performance.now();
      const initialAssetState = typeof getRecommendationAssetState === "function"
        ? getRecommendationAssetState()
        : "network";
      const embeddingStarted = performance.now();
      const assetPromise = preloadRecommendationAssets("search");
      const queryPromise = typeof embedQueryDetailed === "function"
        ? embedQueryDetailed(subjectQuery)
        : embedQuery(subjectQuery).then((vector) => ({
          vector,
          modelVersion: "unknown",
          dimension: vector.length,
          queryCacheState: "unknown" as QueryCacheState,
          requestMs: performance.now() - embeddingStarted,
        }));
      const [assets, query] = await Promise.all([assetPromise, queryPromise]);
      const assetState = initialAssetState === "network" && assets.assetSource === "indexed_db"
        ? "indexed_db"
        : initialAssetState;
      return {
        catalog: assets.catalog,
        courseIds: assets.courseIds,
        vectors: assets.vectors,
        dimension: assets.dimension,
        query: query.vector,
        searchIndex: assets.searchIndex,
        assetWaitMs: performance.now() - assetStarted,
        embeddingMs: query.requestMs ?? performance.now() - embeddingStarted,
        assetState,
        queryCacheState: query.queryCacheState,
      };
    },
  });
}

export interface AssistantAsk {
  question: string;
  history: AIHistoryTurn[];
  context: AIAskContext;
}

export function useAskCourseAssistant() {
  return useMutation({
    mutationFn: async ({ question, history, context }: AssistantAsk): Promise<AIAnswer> => {
      const catalog = await getCatalog();
      const analysis = analyzeQuery(question, { catalog });
      return askCourseAssistant({
        request_id: crypto.randomUUID(),
        question,
        history,
        context,
        hard_constraints: analysis.hardConstraints as HardConstraints,
      });
    },
  });
}
