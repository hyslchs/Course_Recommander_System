/**
 * The analytics transport: a fire-and-forget queue in front of one POST.
 *
 * Non-negotiable properties, in the order the brief puts them:
 *
 * 1. **Nothing here is ever awaited by the UI.** `track()` is synchronous, does
 *    an array push, and returns. The network call happens later, off the
 *    interaction path. Search and recommendation must not wait for analytics,
 *    so they never do.
 * 2. **A failure is a no-op.** Every send is `.catch()`-ed to nothing. If the
 *    analytics endpoint is down, slow, blocked by an extension or 500-ing, the
 *    product behaves exactly as it does when it is up.
 * 3. **No permanent identifier.** The only id this module mints is a session id
 *    living in `sessionStorage` — gone when the tab closes, and additionally
 *    expired after {@link SESSION_MAX_AGE_MS} or {@link SESSION_IDLE_MS} of
 *    inactivity, whichever comes first. `localStorage` holds exactly one
 *    analytics key and it is the opt-out flag, which is a setting, not an id.
 */

import {
  ANALYTICS_ENDPOINT,
  MAX_EVENTS_PER_BATCH,
  type AnalyticsContext,
  type AnalyticsEnvelope,
  type AnalyticsEventMap,
  type AnalyticsEventName,
  type AnalyticsPage,
  type AnalyticsProvenance,
} from "./events";

/** A session ends after two hours however active the tab is. */
export const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** …or after thirty minutes without a tracked interaction. */
export const SESSION_IDLE_MS = 30 * 60 * 1000;
/** Batching window. Long enough to coalesce a burst, short enough to survive a tab close. */
export const FLUSH_DELAY_MS = 4000;
/** Backstop against an offline tab growing the queue without bound. */
const MAX_QUEUED_EVENTS = 200;
/** Consecutive transport failures before this session stops trying. */
const FAILURE_LIMIT = 5;
/** 4xx codes that describe one request rather than a broken payload shape. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 413, 429]);

export const OPT_OUT_STORAGE_KEY = "fju-analytics-opt-out";
const SESSION_STORAGE_KEY = "fju-analytics-session";

interface SessionRecord {
  id: string;
  startedAt: number;
  lastSeenAt: number;
}

let queue: AnalyticsEnvelope[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let failureCount = 0;
let sessionDisabled = false;
let listenersAttached = false;
let memorySession: SessionRecord | undefined;
/** The route the app is currently on, so events raised deep in a tree carry it. */
let currentPage: AnalyticsPage | undefined;
let instrumentationV3Enabled = false;
const configuredClientBuildSha = (globalThis as typeof globalThis & { __FJU_CLIENT_BUILD_SHA__?: unknown }).__FJU_CLIENT_BUILD_SHA__;
let analyticsProvenance: AnalyticsProvenance = {
  client_build_sha: typeof configuredClientBuildSha === "string" && configuredClientBuildSha ? configuredClientBuildSha : "frontend-1.0.0",
  client_ranking_version: "rank-courses-v1",
  client_query_analysis_version: "deterministic-v1",
};

function randomToken(bytes = 6): string {
  const buffer = new Uint8Array(bytes);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(buffer);
  } else {
    for (let index = 0; index < buffer.length; index += 1) buffer[index] = Math.floor(Math.random() * 256);
  }
  return Array.from(buffer, (value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * A short-lived id for one operation — a search, one recommendation run, one
 * refinement flow. It links `impression -> click -> add` and is never written to
 * any storage: it lives in a React ref for as long as that operation is on
 * screen, and the server nulls it out of the raw table after a week.
 */
export function newInteractionId(prefix: "search" | "rec" | "flow"): string {
  return `${prefix}_${randomToken(5)}`;
}

/** Runtime kill switch supplied by `/api/v1/features`; false is the safe default. */
export function setAnalyticsInstrumentationV3(enabled: boolean): void {
  instrumentationV3Enabled = enabled;
}

export function isAnalyticsInstrumentationV3Enabled(): boolean {
  return instrumentationV3Enabled;
}

/** Updates only bounded client provenance; no user or query data enters this object. */
export function setAnalyticsProvenance(provenance: AnalyticsProvenance): void {
  analyticsProvenance = { ...analyticsProvenance, ...provenance };
}

// -- opt-out ---------------------------------------------------------------- //

function readStorage(storage: "local" | "session", key: string): string | null {
  try {
    return (storage === "local" ? window.localStorage : window.sessionStorage).getItem(key);
  } catch {
    return null; // Private mode or storage disabled.
  }
}

function writeStorage(storage: "local" | "session", key: string, value: string | null): void {
  try {
    const target = storage === "local" ? window.localStorage : window.sessionStorage;
    if (value === null) target.removeItem(key);
    else target.setItem(key, value);
  } catch {
    // Nothing to do: analytics degrades, the product does not.
  }
}

/** Honours the browser's Do Not Track signal without needing a UI toggle. */
function browserOptsOut(): boolean {
  if (typeof navigator === "undefined") return false;
  const signal =
    navigator.doNotTrack ??
    (window as unknown as { doNotTrack?: string }).doNotTrack ??
    (navigator as unknown as { msDoNotTrack?: string }).msDoNotTrack;
  return signal === "1" || signal === "yes";
}

export function isAnalyticsOptedOut(): boolean {
  return browserOptsOut() || readStorage("local", OPT_OUT_STORAGE_KEY) === "1";
}

/**
 * The student-facing switch (資料管理 → 使用統計). Stored in `localStorage`
 * because the client has to know the answer before its first paint and every
 * IndexedDB read is async — the same trade-off `hooks/theme.tsx` documents. It
 * holds `"1"` or nothing; it is not an identifier and cannot be used as one.
 */
export function setAnalyticsOptOut(optedOut: boolean): void {
  writeStorage("local", OPT_OUT_STORAGE_KEY, optedOut ? "1" : null);
  if (optedOut) {
    queue = [];
    writeStorage("session", SESSION_STORAGE_KEY, null);
    memorySession = undefined;
  }
}

export function isAnalyticsEnabled(): boolean {
  return typeof window !== "undefined" && !sessionDisabled && !isAnalyticsOptedOut();
}

// -- session ---------------------------------------------------------------- //

function loadSession(): SessionRecord | undefined {
  const raw = readStorage("session", SESSION_STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<SessionRecord>;
      if (typeof parsed.id === "string" && typeof parsed.startedAt === "number" && typeof parsed.lastSeenAt === "number") {
        return parsed as SessionRecord;
      }
    } catch {
      // Corrupt value; a fresh session is the right answer.
    }
  }
  return memorySession;
}

function saveSession(record: SessionRecord): void {
  memorySession = record;
  writeStorage("session", SESSION_STORAGE_KEY, JSON.stringify(record));
}

/**
 * The current session id, rolling it over when it expires.
 *
 * `sessionStorage`, never `localStorage`: it is scoped to the tab and cleared
 * when the tab closes, which is exactly the lifetime §3 asks for. The two
 * timeouts on top of that stop a tab left open for a week from carrying one id
 * across days.
 */
export function currentSessionId(now = Date.now()): string {
  const existing = loadSession();
  if (existing && now - existing.startedAt < SESSION_MAX_AGE_MS && now - existing.lastSeenAt < SESSION_IDLE_MS) {
    saveSession({ ...existing, lastSeenAt: now });
    return existing.id;
  }
  const record: SessionRecord = { id: `tmp_${randomToken(6)}`, startedAt: now, lastSeenAt: now };
  saveSession(record);
  return record.id;
}

// -- transport -------------------------------------------------------------- //

function attachLifecycleListeners(): void {
  if (listenersAttached || typeof window === "undefined") return;
  listenersAttached = true;
  // `visibilitychange` (hidden) is the reliable "the user is leaving" signal on
  // mobile Safari, where `unload` and `beforeunload` frequently never fire.
  const onHide = () => { if (document.visibilityState === "hidden") flushAnalytics({ beacon: true }); };
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", () => flushAnalytics({ beacon: true }));
}

function scheduleFlush(delay: number): void {
  if (typeof window === "undefined") return;
  if (flushTimer !== undefined) {
    if (delay > 0) return; // A timer is already pending; do not push it out.
    clearTimeout(flushTimer);
  }
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    flushAnalytics();
  }, delay);
}

function onTransportFailure(fatal: boolean): void {
  failureCount += 1;
  if (fatal || failureCount >= FAILURE_LIMIT) {
    // A 4xx means this build is sending something the server will never accept;
    // retrying it for the rest of the session is pure waste. Stop, silently.
    sessionDisabled = true;
    queue = [];
  }
}

/**
 * Sends what is queued. Safe to call at any time, including from an unload
 * handler; returns immediately and never rejects.
 *
 * @param beacon prefer `navigator.sendBeacon`, which the browser delivers after
 * the page is gone. Used on hide/unload; the timed flush uses `fetch` so it can
 * observe failures and open the circuit breaker.
 */
export function flushAnalytics({ beacon = false }: { beacon?: boolean } = {}): void {
  if (!queue.length || typeof window === "undefined") return;
  if (!isAnalyticsEnabled()) { queue = []; return; }

  const batch = queue.slice(0, MAX_EVENTS_PER_BATCH);
  queue = queue.slice(batch.length);
  const body = JSON.stringify({ events: batch });

  if (beacon && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    try {
      navigator.sendBeacon(ANALYTICS_ENDPOINT, new Blob([body], { type: "application/json" }));
    } catch {
      // The page is going away; there is nothing useful left to do.
    }
    if (queue.length) flushAnalytics({ beacon: true });
    return;
  }

  void fetch(ANALYTICS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    // Lets the request outlive the page, and keeps it out of the connection
    // pool the app's own requests use.
    keepalive: true,
  })
    .then((response) => {
      if (response.ok) failureCount = 0;
      // A 4xx means this build is sending something the server will never
      // accept — except 429 (slow down) and 413 (this *batch* was too big),
      // which are about one request, not about the payload shape. Treating
      // either as fatal would switch analytics off for the session over a
      // transient condition.
      else onTransportFailure(RETRYABLE_STATUSES.has(response.status) ? false : response.status >= 400 && response.status < 500);
    })
    .catch(() => onTransportFailure(false));

  if (queue.length) scheduleFlush(0);
}

// -- public API ------------------------------------------------------------- //

/** Records the route, so events raised by deep components carry their page. */
export function setAnalyticsPage(page: AnalyticsPage | undefined): void {
  currentPage = page;
}

/**
 * Queue one event. Synchronous, allocation-only, and impossible to make throw —
 * every call site is inside a click handler or a render effect on the critical
 * path, so this must cost nothing observable.
 */
export function track<K extends AnalyticsEventName>(
  event: K,
  data: AnalyticsEventMap[K],
  context: AnalyticsContext = {},
): void {
  if (!isAnalyticsEnabled()) return;
  try {
    attachLifecycleListeners();
    const envelope: AnalyticsEnvelope<K> = {
      event,
      timestamp: new Date().toISOString(),
      session_id: currentSessionId(),
      data,
    };
    if (instrumentationV3Enabled) envelope.schema_version = 3;
    const page = context.page ?? currentPage;
    if (page) envelope.page = page;
    if (context.interactionId) envelope.interaction_id = context.interactionId;
    if (instrumentationV3Enabled) envelope.provenance = analyticsProvenance;

    queue.push(envelope as AnalyticsEnvelope);
    // Drop the oldest, not the newest: a tab that has been offline for an hour
    // should report what just happened, not what happened first.
    if (queue.length > MAX_QUEUED_EVENTS) queue = queue.slice(queue.length - MAX_QUEUED_EVENTS);
    scheduleFlush(queue.length >= MAX_EVENTS_PER_BATCH ? 0 : FLUSH_DELAY_MS);
  } catch {
    // Analytics must never surface as a broken interaction.
  }
}

/** Sends a Phase 1-only event; old backends and disabled gates receive nothing. */
export function trackV3<K extends AnalyticsEventName>(
  event: K,
  data: AnalyticsEventMap[K],
  context: AnalyticsContext = {},
): void {
  if (!instrumentationV3Enabled) return;
  track(event, data, context);
}

/** Sends enhanced data when Phase 1 is enabled and the legacy shape otherwise. */
export function trackWithLegacy<K extends AnalyticsEventName>(
  event: K,
  v3Data: AnalyticsEventMap[K],
  legacyData: AnalyticsEventMap[K],
  context: AnalyticsContext = {},
): void {
  track(event, instrumentationV3Enabled ? v3Data : legacyData, context);
}

/** Test seam. Not used by the app. */
export function __resetAnalyticsForTests(): void {
  queue = [];
  failureCount = 0;
  sessionDisabled = false;
  instrumentationV3Enabled = false;
  analyticsProvenance = {
    client_build_sha: typeof configuredClientBuildSha === "string" && configuredClientBuildSha ? configuredClientBuildSha : "frontend-1.0.0",
    client_ranking_version: "rank-courses-v1",
    client_query_analysis_version: "deterministic-v1",
  };
  memorySession = undefined;
  currentPage = undefined;
  if (flushTimer !== undefined) clearTimeout(flushTimer);
  flushTimer = undefined;
  writeStorage("session", SESSION_STORAGE_KEY, null);
  writeStorage("local", OPT_OUT_STORAGE_KEY, null);
}

/** Test seam. Not used by the app. */
export function __queuedEventsForTests(): readonly AnalyticsEnvelope[] {
  return queue;
}
