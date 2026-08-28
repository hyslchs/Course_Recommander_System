/**
 * The analytics event contract, mirrored from `src/fju_outline/analytics.py`.
 *
 * The server is the authority — it re-validates every field and drops anything
 * it does not recognise — but the types here make a mismatch a compile error
 * rather than a row silently missing from the dashboard. If you add an event or
 * a value, change both files.
 *
 * Two rules govern what may appear below, and they are why every payload field
 * is a union of literals or a number:
 *
 * - **Nothing free-text.** No `innerText`, no query string, no URL, no error
 *   message, no course name. `feature`/`filter`/`component` are identifiers
 *   written in this file, not labels read off the DOM.
 * - **Nothing about the student.** Department, grade, minor, double major,
 *   completed courses and the timetable stay in IndexedDB. There is no field
 *   here that could carry them, deliberately.
 */

export const ANALYTICS_ENDPOINT = "/api/v1/analytics/events";

/** Kept in step with the server's `MAX_EVENTS_PER_BATCH`. */
export const MAX_EVENTS_PER_BATCH = 40;

export type AnalyticsPage =
  | "assistant"
  | "course_search"
  | "data_management"
  | "not_found"
  | "privacy"
  | "recommendation"
  | "schedule"
  | "settings";

export type AnalyticsFeature =
  | "clear_filters"
  | "clear_local_data"
  | "dismiss_recommendation"
  | "export_backup"
  | "export_schedule"
  | "import_backup"
  | "mark_completed"
  | "open_course_detail"
  | "open_dcard_reviews"
  | "open_filter_drawer"
  | "open_full_filter"
  | "open_official_syllabus"
  | "open_slot_recommendation"
  | "switch_schedule_view"
  | "toggle_favorite"
  | "use_topic_example";

export type AnalyticsFilter =
  | "assessment_method"
  | "assessment_style"
  | "class_time"
  | "conflict_filter"
  | "core_competency"
  | "course_category"
  | "course_tag"
  | "credits"
  | "department"
  | "division"
  | "include_unknown_schedule"
  | "instructor"
  | "literacy"
  | "material_language"
  | "online_teaching"
  | "show_other_weekdays"
  | "special_issue"
  | "teaching_language"
  | "teaching_method"
  | "weekday";

export type SearchMode = "keyword" | "semantic";
export type RecommendationAssetState = "prefetched" | "in_flight" | "indexed_db" | "network";
export type QueryCacheState = "hit" | "miss" | "unknown";
export type RecommendationMethod = "schedule_slot" | "semantic";
export type CourseAddSource = "manual" | "recommendation" | "schedule_slot" | "search";
export type ConflictAction =
  | "cancel_add"
  | "disable_conflict_filter"
  | "enable_conflict_filter"
  | "keep_conflict"
  | "remove_course";

export type ApiEndpointName =
  | "ai_ask"
  | "catalog_data"
  | "catalog_summary"
  | "catalog_manifest"
  | "class_groups"
  | "course_detail"
  | "courses"
  | "courses_batch"
  | "courses_lookup"
  | "departments"
  | "embeddings_data"
  | "embeddings_index"
  | "facets"
  | "features"
  | "query_embedding"
  | "query_embeddings"
  | "query_routes_data"
  | "query_routes_index";

export type ErrorComponent =
  | "app_shell"
  | "assistant"
  | "catalog"
  | "course_search"
  | "data_management"
  | "embedding"
  | "recommendation"
  | "schedule";

export type ErrorCode =
  | "API_REQUEST_FAILED"
  | "CATALOG_LOAD_FAILED"
  | "COURSE_LOOKUP_FAILED"
  | "COURSE_QUERY_FAILED"
  | "EMBEDDING_REQUEST_FAILED"
  | "LOCAL_STORAGE_FAILED"
  | "RENDER_ERROR"
  | "SCHEDULE_WRITE_FAILED"
  | "UNKNOWN"
  | "VECTOR_LOAD_FAILED";

/**
 * `filter_used.value` is only sent for filters whose options form a closed,
 * non-identifying set. For an open set (department, instructor, course tag,
 * teaching method, …) the event records *that the filter was used* and nothing
 * else: "which filters do students reach for?" is the question, and a selected
 * department code does not help answer it.
 */
export const FILTERS_WITH_VALUE: ReadonlySet<AnalyticsFilter> = new Set<AnalyticsFilter>([
  "assessment_style",
  "class_time",
  "conflict_filter",
  "course_category",
  "credits",
  "include_unknown_schedule",
  "online_teaching",
  "show_other_weekdays",
  "weekday",
]);

/** Mirrors the server's `FILTER_VALUE_PATTERN`. */
export const FILTER_VALUE_PATTERN = /^[a-z0-9_.:-]{1,32}$/;

export type AnalyticsEventMap = {
  page_view: { page: AnalyticsPage };
  feature_clicked: { feature: AnalyticsFeature };
  filter_used: { filter: AnalyticsFilter; value?: string };
  search: {
    search_mode: SearchMode;
    query_length: number;
    result_count: number;
    /** Backward-compatible end-to-end total, measured at recommendation completion. */
    latency_ms: number;
    total_ms?: number;
    asset_wait_ms?: number;
    embedding_ms?: number;
    ranking_ms?: number;
    asset_state?: RecommendationAssetState;
    query_cache_state?: QueryCacheState;
  };
  zero_result: { search_mode: SearchMode };
  search_refined: { refinement_index: number };
  recommendation_impression: { course_id: string; position: number; method: RecommendationMethod };
  recommendation_clicked: { course_id: string; position: number; method?: RecommendationMethod };
  recommendation_skipped: { result_count: number; method?: RecommendationMethod };
  course_added: { course_id: string; source: CourseAddSource; position?: number };
  course_removed: { course_id: string };
  schedule_conflict: { conflict_count: number; action: "course_added" };
  schedule_conflict_action: { action: ConflictAction };
  api_performance: { endpoint: ApiEndpointName; latency_ms: number; status: number };
  error: { component: ErrorComponent; error_code: ErrorCode };
};

export type AnalyticsEventName = keyof AnalyticsEventMap;

export interface AnalyticsEnvelope<K extends AnalyticsEventName = AnalyticsEventName> {
  event: K;
  timestamp: string;
  page?: AnalyticsPage;
  session_id?: string;
  interaction_id?: string;
  data: AnalyticsEventMap[K];
}

/** Optional per-call context. Neither id is ever persisted across a browser session. */
export interface AnalyticsContext {
  page?: AnalyticsPage;
  interactionId?: string;
}

const ROUTE_PAGES: Readonly<Record<string, AnalyticsPage>> = {
  "/assistant": "assistant",
  "/data": "data_management",
  "/explore": "course_search",
  "/onboarding": "settings",
  "/privacy": "privacy",
  "/recommend": "recommendation",
  "/schedule": "schedule",
};

/**
 * Route path -> page enum. Only the pathname is consulted and only against this
 * table, so a query string or a path segment can never become an analytics
 * value — an unrecognised route reports `not_found`, not its own URL.
 */
export function pageForPath(pathname: string): AnalyticsPage {
  return ROUTE_PAGES[pathname] ?? "not_found";
}
