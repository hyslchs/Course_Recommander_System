"""Privacy-first product analytics.

Design rules this module exists to enforce, in the order they matter:

1. **No identity.** There is no `user_id`, no device id and no persistent user
   UUID anywhere in this file or in the schema it creates. The correlation keys
   are a browser-session `session_id` and a per-operation `interaction_id`, and
   :meth:`AnalyticsStore.maintain` *nulls both out* after
   ``FJU_ANALYTICS_ID_RETENTION_DAYS`` (7) days, so a row older than a week
   cannot be joined to any other row at all.
   ``event_id`` is only an opaque one-event retry key; it is not exposed in
   reports and does not identify a browser or student.
2. **No free text, ever.** Every accepted field is an enum member, a bounded
   integer, or a `course_id` that must already exist in the served catalog.
   Raw search queries are not accepted by any event; see ``README`` §Analytics.
3. **No JSON blob.** The request body is never persisted. Validation projects
   each event onto a fixed set of typed columns, so a property that is not in
   :data:`EVENT_SCHEMAS` has no column to land in even if validation were
   bypassed.
4. **No IP.** The payload has no address field, and nothing here reads
   ``request.client`` or ``X-Forwarded-For``. The one place the client address is
   touched is the shared in-memory rate limiter in ``web.py``, which keeps a
   deque of timestamps and never writes to disk.

The browser/OS/device columns are derived server-side from ``User-Agent`` and
reduced to four coarse values (family, major, OS family, form factor). The raw
header is deliberately not stored: it is the single highest-entropy string a
browser sends, and compatibility analysis needs none of it.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

# Version 3 already exists in this repository for the semantic-search timing
# fields.  Phase 1 is therefore the next additive storage migration.
SCHEMA_VERSION = 4
EVENT_SCHEMA_VERSIONS: frozenset[int] = frozenset({2, 3})

logger = logging.getLogger(__name__)

MAX_EVENTS_PER_BATCH = 40

#: Property names that must never reach analytics storage. `extra="forbid"`-style
#: projection already drops anything not in :data:`EVENT_SCHEMAS`; this list is
#: the second, independent gate, checked against the *raw* payload before
#: projection so a future loosening of a schema cannot silently open a hole. It
#: is matched case-insensitively against every key at every nesting depth.
FORBIDDEN_KEYS: frozenset[str] = frozenset({
    "auth",
    "authorization",
    "birthday",
    "client_ip",
    "cookie",
    "cookies",
    "department",
    "device_id",
    "email",
    "fingerprint",
    "gpa",
    "grade",
    "grades",
    "headers",
    "interests",
    "ip",
    "ip_address",
    "latitude",
    "location",
    "longitude",
    "major",
    "minor",
    "name",
    "phone",
    "profile",
    "query",
    "raw_query",
    "referrer",
    "request_body",
    "schedule",
    "search_query",
    "session_token",
    "student_id",
    "token",
    "transcript",
    "url",
    "user",
    "user_agent",
    "user_id",
    "uuid",
    "x-forwarded-for",
})

PAGES: frozenset[str] = frozenset({
    "assistant",
    "course_search",
    "data_management",
    "not_found",
    "privacy",
    "recommendation",
    "schedule",
    "settings",
})

FEATURES: frozenset[str] = frozenset({
    "clear_filters",
    "clear_local_data",
    "dismiss_recommendation",
    "export_backup",
    "export_schedule",
    "import_backup",
    "mark_completed",
    "open_course_detail",
    "open_dcard_reviews",
    "open_filter_drawer",
    "open_full_filter",
    "open_official_syllabus",
    "open_slot_recommendation",
    "switch_schedule_view",
    "toggle_favorite",
    "use_topic_example",
})

FILTERS: frozenset[str] = frozenset({
    "assessment_method",
    "assessment_style",
    "class_time",
    "conflict_filter",
    "core_competency",
    "course_category",
    "course_tag",
    "credits",
    "department",
    "division",
    "include_unknown_schedule",
    "instructor",
    "literacy",
    "material_language",
    "online_teaching",
    "show_other_weekdays",
    "special_issue",
    "teaching_language",
    "teaching_method",
    "weekday",
})

SEARCH_MODES: frozenset[str] = frozenset({"keyword", "semantic"})
SEARCH_ASSET_STATES: frozenset[str] = frozenset({"prefetched", "in_flight", "indexed_db", "network"})
SEARCH_QUERY_CACHE_STATES: frozenset[str] = frozenset({"hit", "miss", "unknown"})
RECOMMENDATION_METHODS: frozenset[str] = frozenset({"schedule_slot", "semantic"})
ADD_SOURCES: frozenset[str] = frozenset({"manual", "recommendation", "schedule_slot", "search"})
DEPARTMENT_RELATIONS: frozenset[str] = frozenset({"same_department", "other_department", "unknown"})
AGE_BUCKETS: frozenset[str] = frozenset({"under_10m", "10m_to_1h", "1h_to_24h", "1d_to_7d", "over_7d", "unknown"})
ELAPSED_ORIGINS: frozenset[str] = frozenset({"recommendation_result", "search_result", "schedule_slot_result"})
RUN_OUTCOMES: frozenset[str] = frozenset({"results", "zero_result", "error", "abandoned"})
PROVENANCE_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
ELAPSED_MAX_MS = 7_200_000
RESEARCH_REPORT_VERSION = "phase2-research-v1"
LEGACY_REPORT_VERSION = "legacy-mixed-v1"
MIN_RESEARCH_SLICE_N = 10
DECISION_TIME_BUCKETS: tuple[tuple[str, int, int], ...] = (
    ("under_1s", 0, 1_000),
    ("1s_to_5s", 1_000, 5_000),
    ("5s_to_10s", 5_000, 10_000),
    ("10s_to_30s", 10_000, 30_000),
    ("30s_to_60s", 30_000, 60_000),
    ("1m_to_5m", 60_000, 300_000),
    ("5m_to_15m", 300_000, 900_000),
    ("15m_to_30m", 900_000, 1_800_000),
    ("30m_to_60m", 1_800_000, 3_600_000),
    ("60m_to_120m", 3_600_000, 7_200_001),
)
CONFLICT_TRIGGERS: frozenset[str] = frozenset({"course_added"})
CONFLICT_ACTIONS: frozenset[str] = frozenset({
    "cancel_add",
    "disable_conflict_filter",
    "enable_conflict_filter",
    "keep_conflict",
    "remove_course",
})

#: Logical endpoint names. Never a URL: a path can carry a course id or a query
#: string, and `api_performance` has no business holding either.
#: `analytics_events` is deliberately absent — instrumenting the analytics POST
#: would make every flush generate another event to flush.
API_ENDPOINTS: frozenset[str] = frozenset({
    "ai_ask",
    "catalog_data",
    "catalog_summary",
    "catalog_manifest",
    "class_groups",
    "course_detail",
    "courses",
    "courses_batch",
    "courses_lookup",
    "departments",
    "embeddings_data",
    "embeddings_index",
    "facets",
    "features",
    "query_embedding",
    "query_embeddings",
    "query_routes_data",
    "query_routes_index",
})

ERROR_COMPONENTS: frozenset[str] = frozenset({
    "app_shell",
    "assistant",
    "catalog",
    "course_search",
    "data_management",
    "embedding",
    "recommendation",
    "schedule",
})

ERROR_CODES: frozenset[str] = frozenset({
    "API_REQUEST_FAILED",
    "CATALOG_LOAD_FAILED",
    "COURSE_LOOKUP_FAILED",
    "COURSE_QUERY_FAILED",
    "EMBEDDING_REQUEST_FAILED",
    "LOCAL_STORAGE_FAILED",
    "RENDER_ERROR",
    "SCHEDULE_WRITE_FAILED",
    "UNKNOWN",
    "VECTOR_LOAD_FAILED",
})

#: Filters whose selected value is itself a bounded, non-identifying token. Every
#: other filter records only *that it was used*: an instructor id or a department
#: identity says more about the catalog than about filter ergonomics, and the
#: metric this event exists for ("which filters do students actually touch?")
#: does not need it.
FILTER_VALUE_PATTERN = re.compile(r"^[a-z0-9_.:-]{1,32}$")

COURSE_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")
SESSION_ID_PATTERN = re.compile(r"^tmp_[a-z0-9]{6,24}$")
INTERACTION_ID_PATTERN = re.compile(r"^(?:search|rec|flow)_[a-z0-9]{4,24}$")
EVENT_ID_PATTERN = re.compile(r"^evt_[a-f0-9]{32}$")

PROVENANCE_FIELDS: frozenset[str] = frozenset({
    "client_build_sha",
    "client_artifact_version",
    "client_artifact_bundle_id",
    "client_model_revision",
    "client_ranking_version",
    "client_query_analysis_version",
})


class AnalyticsRejection(ValueError):
    """A payload that violates the contract badly enough to answer 4xx with."""


class AnalyticsCapacityError(RuntimeError):
    """The analytics store cannot safely accept another batch."""


@dataclass(frozen=True)
class Field:
    """One accepted property of one event."""

    column: str
    kind: str  # "enum" | "int" | "course_id" | "token"
    values: frozenset[str] | None = None
    minimum: int = 0
    maximum: int = 0
    required: bool = True


def _enum(column: str, values: frozenset[str], *, required: bool = True) -> Field:
    return Field(column=column, kind="enum", values=values, required=required)


def _int(column: str, *, minimum: int, maximum: int, required: bool = True) -> Field:
    return Field(column=column, kind="int", minimum=minimum, maximum=maximum, required=required)


#: The allowlist. An event name absent from this mapping is rejected; a property
#: absent from an event's mapping is rejected. There is no wildcard branch.
EVENT_SCHEMAS: dict[str, dict[str, Field]] = {
    "page_view": {
        "page": _enum("page", PAGES),
    },
    "feature_clicked": {
        "feature": _enum("feature", FEATURES),
    },
    "filter_used": {
        "filter": _enum("filter_name", FILTERS),
        "value": Field(column="filter_value", kind="token", required=False),
    },
    "search": {
        "search_mode": _enum("search_mode", SEARCH_MODES),
        # Length, not content. 500 is the input `maxLength` the two search
        # surfaces already enforce.
        "query_length": _int("query_length", minimum=0, maximum=500),
        "result_count": _int("result_count", minimum=0, maximum=100_000),
        "latency_ms": _int("latency_ms", minimum=0, maximum=120_000),
        # Optional so old clients and old queued events remain valid. New
        # recommendation events fill all four fields; keyword search does not.
        "asset_wait_ms": _int("asset_wait_ms", minimum=0, maximum=120_000, required=False),
        "embedding_ms": _int("embedding_ms", minimum=0, maximum=120_000, required=False),
        "ranking_ms": _int("ranking_ms", minimum=0, maximum=120_000, required=False),
        "total_ms": _int("total_ms", minimum=0, maximum=120_000, required=False),
        "asset_state": _enum("asset_state", SEARCH_ASSET_STATES, required=False),
        "query_cache_state": _enum("query_cache_state", SEARCH_QUERY_CACHE_STATES, required=False),
    },
    "zero_result": {
        "search_mode": _enum("search_mode", SEARCH_MODES),
    },
    "search_refined": {
        "refinement_index": _int("refinement_index", minimum=1, maximum=100),
    },
    "recommendation_impression": {
        "course_id": Field(column="course_id", kind="course_id"),
        "position": _int("position", minimum=1, maximum=100_000),
        "method": _enum("method", RECOMMENDATION_METHODS),
        "department_relation": _enum("department_relation", DEPARTMENT_RELATIONS, required=False),
    },
    "recommendation_clicked": {
        "course_id": Field(column="course_id", kind="course_id"),
        "position": _int("position", minimum=1, maximum=100_000),
        "method": _enum("method", RECOMMENDATION_METHODS, required=False),
        "elapsed_ms": _int("elapsed_ms", minimum=0, maximum=ELAPSED_MAX_MS, required=False),
        "elapsed_origin": _enum("elapsed_origin", ELAPSED_ORIGINS, required=False),
        "department_relation": _enum("department_relation", DEPARTMENT_RELATIONS, required=False),
    },
    "recommendation_skipped": {
        "result_count": _int("result_count", minimum=0, maximum=100_000),
        "method": _enum("method", RECOMMENDATION_METHODS, required=False),
    },
    "recommendation_run_completed": {
        "method": _enum("method", RECOMMENDATION_METHODS),
        "result_count": _int("result_count", minimum=0, maximum=100_000),
        "impression_count": _int("impression_count", minimum=0, maximum=100_000),
        "click_count": _int("click_count", minimum=0, maximum=100_000),
        "add_count": _int("add_count", minimum=0, maximum=100_000),
        "outcome": _enum("outcome", RUN_OUTCOMES),
    },
    "search_result_impression": {
        "course_id": Field(column="course_id", kind="course_id"),
        "position": _int("position", minimum=1, maximum=100_000),
        "search_mode": _enum("search_mode", SEARCH_MODES),
    },
    "search_result_clicked": {
        "course_id": Field(column="course_id", kind="course_id"),
        "position": _int("position", minimum=1, maximum=100_000),
        "search_mode": _enum("search_mode", SEARCH_MODES),
        "elapsed_ms": _int("elapsed_ms", minimum=0, maximum=ELAPSED_MAX_MS, required=False),
        "elapsed_origin": _enum("elapsed_origin", ELAPSED_ORIGINS, required=False),
    },
    "course_added": {
        "course_id": Field(column="course_id", kind="course_id"),
        "source": _enum("source", ADD_SOURCES),
        "position": _int("position", minimum=1, maximum=100_000, required=False),
        "elapsed_ms": _int("elapsed_ms", minimum=0, maximum=ELAPSED_MAX_MS, required=False),
        "elapsed_origin": _enum("elapsed_origin", ELAPSED_ORIGINS, required=False),
        "department_relation": _enum("department_relation", DEPARTMENT_RELATIONS, required=False),
    },
    "course_removed": {
        "course_id": Field(column="course_id", kind="course_id"),
        "original_source": _enum("original_source", ADD_SOURCES, required=False),
        "age_bucket": _enum("age_bucket", AGE_BUCKETS, required=False),
    },
    "course_readded": {
        "course_id": Field(column="course_id", kind="course_id"),
        "source": _enum("source", ADD_SOURCES),
    },
    "schedule_conflict": {
        # `conflict_count` is the v2 compatibility field. New clients send the
        # actual/uncertain pair; validation below requires at least one form.
        "conflict_count": _int("conflict_count", minimum=0, maximum=100, required=False),
        "actual_conflict_count": _int("actual_conflict_count", minimum=0, maximum=100, required=False),
        "uncertain_conflict_count": _int("uncertain_conflict_count", minimum=0, maximum=100, required=False),
        "action": _enum("action", CONFLICT_TRIGGERS),
    },
    "schedule_conflict_action": {
        "action": _enum("action", CONFLICT_ACTIONS),
    },
    "api_performance": {
        "endpoint": _enum("endpoint", API_ENDPOINTS),
        "latency_ms": _int("latency_ms", minimum=0, maximum=120_000),
        "status": _int("status", minimum=0, maximum=599),
    },
    "error": {
        "component": _enum("component", ERROR_COMPONENTS),
        "error_code": _enum("error_code", ERROR_CODES),
    },
}

EVENT_NAMES: frozenset[str] = frozenset(EVENT_SCHEMAS)

# These events are the additive Phase 1 contract. The gate in web.py can
# reject them while leaving the original event stream and schema untouched.
PHASE_ONE_V3_EVENTS: frozenset[str] = frozenset({
    "recommendation_run_completed",
    "search_result_impression",
    "search_result_clicked",
    "course_readded",
})

#: Every column an event may write, in a stable order. The insert statement is
#: built from this list, so adding a property to `EVENT_SCHEMAS` without adding
#: its column here fails loudly at import instead of silently dropping data.
EVENT_COLUMNS: tuple[str, ...] = (
    "page",
    "course_id",
    "position",
    "method",
    "source",
    "feature",
    "filter_name",
    "filter_value",
    "search_mode",
    "query_length",
    "result_count",
    "latency_ms",
    "asset_wait_ms",
    "embedding_ms",
    "ranking_ms",
    "total_ms",
    "asset_state",
    "query_cache_state",
    "refinement_index",
    "conflict_count",
    "actual_conflict_count",
    "uncertain_conflict_count",
    "action",
    "impression_count",
    "click_count",
    "add_count",
    "outcome",
    "elapsed_ms",
    "elapsed_origin",
    "department_relation",
    "original_source",
    "age_bucket",
    "client_build_sha",
    "client_artifact_version",
    "client_artifact_bundle_id",
    "client_model_revision",
    "client_ranking_version",
    "client_query_analysis_version",
    "server_build_sha",
    "server_artifact_version",
    "server_model_revision",
    "endpoint",
    "status",
    "component",
    "error_code",
)

_declared = {field.column for schema in EVENT_SCHEMAS.values() for field in schema.values()}
assert _declared <= set(EVENT_COLUMNS), sorted(_declared - set(EVENT_COLUMNS))
del _declared


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #

def assert_no_forbidden_keys(payload: Any, *, depth: int = 0) -> None:
    """Reject a payload carrying a denylisted property name at any depth.

    Runs on the raw request body, before projection. The keys it looks for are
    the ones a well-meaning future change is most likely to add (`email`,
    `student_id`, `user_id`, `schedule`, `raw_query`, `token`, `ip`, …), so the
    denylist fails the request rather than quietly discarding the field — a
    silent drop would let a client keep sending personal data forever while
    believing it was being recorded.
    """
    if depth > 6:
        raise AnalyticsRejection("payload nested too deeply")
    if isinstance(payload, dict):
        for key, value in payload.items():
            if str(key).strip().lower() in FORBIDDEN_KEYS:
                raise AnalyticsRejection(f"forbidden property: {key}")
            assert_no_forbidden_keys(value, depth=depth + 1)
    elif isinstance(payload, (list, tuple)):
        for item in payload:
            assert_no_forbidden_keys(item, depth=depth + 1)


def _coerce_int(value: Any, field: Field, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise AnalyticsRejection(f"{name} must be a number")
    number = int(value)
    if number < field.minimum or number > field.maximum:
        raise AnalyticsRejection(f"{name} out of range")
    return number


def validate_event(
    raw: Any,
    *,
    course_exists: Callable[[str], bool] | None = None,
    require_event_id: bool = False,
    derive_event_id: bool = False,
) -> dict[str, Any]:
    """Project one client event onto the typed columns, or raise.

    ``course_exists`` is the served catalog's membership test. Binding
    `course_id` to the catalog is what stops the table from becoming a
    write-anything key/value store: a client can only name courses the server
    is already publishing.
    """
    if not isinstance(raw, dict):
        raise AnalyticsRejection("event must be an object")

    known_top_level = {"event", "event_id", "timestamp", "page", "session_id", "interaction_id", "provenance", "schema_version", "data"}
    unknown = set(map(str, raw)) - known_top_level
    if unknown:
        raise AnalyticsRejection(f"unknown property: {sorted(unknown)[0]}")

    name = raw.get("event")
    if not isinstance(name, str) or name not in EVENT_SCHEMAS:
        raise AnalyticsRejection(f"unknown event: {name!r}")

    row: dict[str, Any] = {"event": name}
    schema_version = raw.get("schema_version", 2)
    if isinstance(schema_version, bool) or not isinstance(schema_version, int) or schema_version not in EVENT_SCHEMA_VERSIONS:
        raise AnalyticsRejection("unsupported schema_version")
    if "schema_version" in raw:
        row["schema_version"] = schema_version

    event_id = raw.get("event_id")
    if event_id is None:
        if require_event_id:
            raise AnalyticsRejection("event_id is required")
    elif not isinstance(event_id, str) or not EVENT_ID_PATTERN.fullmatch(event_id):
        raise AnalyticsRejection("malformed event_id")
    else:
        row["event_id"] = event_id
    if event_id is None and derive_event_id:
        try:
            canonical = json.dumps(raw, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        except (TypeError, ValueError):
            raise AnalyticsRejection("event cannot be fingerprinted") from None
        row["event_id"] = f"evt_{hashlib.sha256(canonical.encode('utf-8')).hexdigest()[:32]}"

    session_id = raw.get("session_id")
    if session_id is not None:
        if not isinstance(session_id, str) or not SESSION_ID_PATTERN.match(session_id):
            raise AnalyticsRejection("malformed session_id")
        row["session_id"] = session_id

    interaction_id = raw.get("interaction_id")
    if interaction_id is not None:
        if not isinstance(interaction_id, str) or not INTERACTION_ID_PATTERN.match(interaction_id):
            raise AnalyticsRejection("malformed interaction_id")
        row["interaction_id"] = interaction_id

    page = raw.get("page")
    if page is not None:
        if not isinstance(page, str) or page not in PAGES:
            raise AnalyticsRejection("unknown page")
        row["page"] = page

    provenance = raw.get("provenance")
    if provenance is not None:
        if not isinstance(provenance, dict):
            raise AnalyticsRejection("provenance must be an object")
        unknown_provenance = set(map(str, provenance)) - PROVENANCE_FIELDS
        if unknown_provenance:
            raise AnalyticsRejection(f"unknown provenance property: {sorted(unknown_provenance)[0]}")
        for key, value in provenance.items():
            if not isinstance(value, str) or not PROVENANCE_TOKEN_PATTERN.fullmatch(value):
                raise AnalyticsRejection(f"provenance.{key} must be a bounded token")
            row[str(key)] = value

    # `timestamp` is accepted for payload compatibility and then dropped: the
    # server's receive time is the one that gets stored. A client clock is both
    # untrustworthy (it can be set to backdate rows past a retention sweep) and
    # a fingerprinting surface (skew is stable per device).
    schema = EVENT_SCHEMAS[name]
    data = raw.get("data") or {}
    if not isinstance(data, dict):
        raise AnalyticsRejection("data must be an object")
    extra = set(map(str, data)) - set(schema)
    if extra:
        raise AnalyticsRejection(f"unknown property for {name}: {sorted(extra)[0]}")

    for key, field in schema.items():
        if key not in data or data[key] is None:
            if field.required:
                raise AnalyticsRejection(f"{name} requires {key}")
            continue
        value = data[key]
        if field.kind == "enum":
            if not isinstance(value, str) or value not in (field.values or frozenset()):
                raise AnalyticsRejection(f"{name}.{key} is not an allowed value")
            row[field.column] = value
        elif field.kind == "int":
            row[field.column] = _coerce_int(value, field, f"{name}.{key}")
        elif field.kind == "course_id":
            if not isinstance(value, str) or not COURSE_ID_PATTERN.match(value):
                raise AnalyticsRejection(f"{name}.{key} is not a course id")
            if course_exists is not None and not course_exists(value):
                raise AnalyticsRejection(f"{name}.{key} is not in the catalog")
            row[field.column] = value
        elif field.kind == "token":
            if not isinstance(value, str) or not FILTER_VALUE_PATTERN.match(value):
                raise AnalyticsRejection(f"{name}.{key} is not a bounded token")
            row[field.column] = value
        else:  # pragma: no cover - guarded by the Field constructors above
            raise AnalyticsRejection(f"unsupported field kind: {field.kind}")

    if name == "schedule_conflict" and not any(
        data.get(key) is not None for key in ("conflict_count", "actual_conflict_count", "uncertain_conflict_count")
    ):
        raise AnalyticsRejection("schedule_conflict requires a conflict count")
    if (data.get("elapsed_ms") is None) != (data.get("elapsed_origin") is None):
        raise AnalyticsRejection("elapsed_ms and elapsed_origin must be provided together")

    # `page` is required context for page_view and already validated above.
    if name == "page_view" and "page" not in row:
        raise AnalyticsRejection("page_view requires page")
    return row


# --------------------------------------------------------------------------- #
# User-Agent reduction
# --------------------------------------------------------------------------- #

_BROWSER_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("Edge", re.compile(r"Edg(?:e|A|iOS)?/(\d{1,4})")),
    ("Samsung Internet", re.compile(r"SamsungBrowser/(\d{1,4})")),
    ("Opera", re.compile(r"OPR/(\d{1,4})")),
    ("Firefox", re.compile(r"(?:Firefox|FxiOS)/(\d{1,4})")),
    ("Chrome", re.compile(r"(?:HeadlessChrome|CriOS|Chrome)/(\d{1,4})")),
    ("Safari", re.compile(r"Version/(\d{1,4})(?:\.\d+)*\s+(?:Mobile/\S+\s+)?Safari")),
)

_OS_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("Windows", re.compile(r"Windows NT")),
    ("ChromeOS", re.compile(r"CrOS")),
    ("Android", re.compile(r"Android")),
    ("iOS", re.compile(r"iPhone|iPad|iPod")),
    ("macOS", re.compile(r"Mac OS X|Macintosh")),
    ("Linux", re.compile(r"Linux|X11")),
)


def reduce_user_agent(user_agent: str | None) -> tuple[str, int | None, str, str]:
    """Reduce ``User-Agent`` to (browser family, major, OS family, form factor).

    Four low-cardinality values, which is the whole compatibility question:
    "does Safari 17 error more than Chrome 151?" and "is mobile slower than
    desktop?". Nothing narrower is derived and the input string is discarded —
    see the module docstring.
    """
    text = (user_agent or "")[:400]
    if not text:
        return ("Unknown", None, "Unknown", "unknown")

    browser, major = "Other", None
    for family, pattern in _BROWSER_PATTERNS:
        match = pattern.search(text)
        if match:
            browser = family
            major = int(match.group(1))
            break

    operating_system = "Other"
    for family, pattern in _OS_PATTERNS:
        if pattern.search(text):
            operating_system = family
            break

    if re.search(r"iPad|Tablet", text) or ("Android" in text and "Mobi" not in text):
        device = "tablet"
    elif re.search(r"Mobi|iPhone|iPod|Windows Phone", text):
        device = "mobile"
    else:
        device = "desktop"
    return (browser, major, operating_system, device)


# --------------------------------------------------------------------------- #
# Storage
# --------------------------------------------------------------------------- #

def _env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class Retention:
    """Every retention window, in one place, all environment-overridable."""

    events_days: int = 180
    diagnostics_days: int = 90
    identifier_days: int = 7

    @classmethod
    def from_env(cls) -> "Retention":
        return cls(
            events_days=_env_int("FJU_ANALYTICS_EVENT_RETENTION_DAYS", 180, minimum=1, maximum=400),
            diagnostics_days=_env_int("FJU_ANALYTICS_DIAGNOSTIC_RETENTION_DAYS", 90, minimum=1, maximum=400),
            identifier_days=_env_int("FJU_ANALYTICS_ID_RETENTION_DAYS", 7, minimum=1, maximum=90),
        )


#: Events whose value is operational rather than product-analytical, and which
#: therefore expire on the shorter window.
DIAGNOSTIC_EVENTS: frozenset[str] = frozenset({"api_performance", "error"})

_INSERT_COLUMNS = ("event_id", "received_at", "day", "event", "schema_version", "session_id", "interaction_id",
                   "browser", "browser_major", "os", "device") + EVENT_COLUMNS
_INSERT_SQL = (
    f"INSERT OR IGNORE INTO analytics_events ({', '.join(_INSERT_COLUMNS)}) "
    f"VALUES ({', '.join('?' * len(_INSERT_COLUMNS))})"
)


def _safe_provenance_token(value: Any) -> str:
    text = str(value or "unknown")
    return text if PROVENANCE_TOKEN_PATTERN.fullmatch(text) else "unknown"


class AnalyticsStore:
    """SQLite-backed event store, aggregator and retention sweeper.

    SQLite because the project already runs one for the AI usage ledger, the
    volume is a few thousand rows a day, and a data warehouse for that would be
    the over-engineering the brief rules out.
    """

    def __init__(
        self,
        path: Path,
        *,
        retention: Retention | None = None,
        max_rows: int | None = None,
        max_db_bytes: int | None = None,
    ) -> None:
        self.path = path
        self.retention = retention or Retention.from_env()
        self.max_rows = max_rows if max_rows is not None else _env_int(
            "FJU_ANALYTICS_MAX_ROWS", 250_000, minimum=1, maximum=10_000_000
        )
        self.max_db_bytes = max_db_bytes if max_db_bytes is not None else _env_int(
            "FJU_ANALYTICS_MAX_DB_BYTES", 64 * 1024 * 1024, minimum=1024, maximum=10 * 1024 * 1024 * 1024
        )
        self._lock = threading.Lock()
        self._last_maintenance = 0.0
        self._event_row_count = 0
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            self._create_schema(connection)
            self._event_row_count = int(connection.execute("SELECT COUNT(*) FROM analytics_events").fetchone()[0])

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA busy_timeout=5000")
        page_size = int(connection.execute("PRAGMA page_size").fetchone()[0])
        max_pages = max(1, self.max_db_bytes // max(1, page_size))
        connection.execute(f"PRAGMA max_page_count = {max_pages}")
        return connection

    @staticmethod
    def _create_schema(connection: sqlite3.Connection) -> None:
        # Typed columns, not a JSON blob: a property with no column cannot be
        # stored even if it somehow got past validation.
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS analytics_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT,
                received_at TEXT NOT NULL,
                day TEXT NOT NULL,
                event TEXT NOT NULL,
                schema_version INTEGER NOT NULL DEFAULT 2,
                session_id TEXT,
                interaction_id TEXT,
                browser TEXT,
                browser_major INTEGER,
                os TEXT,
                device TEXT,
                page TEXT,
                course_id TEXT,
                position INTEGER,
                method TEXT,
                source TEXT,
                feature TEXT,
                filter_name TEXT,
                filter_value TEXT,
                search_mode TEXT,
                query_length INTEGER,
                result_count INTEGER,
                latency_ms INTEGER,
                asset_wait_ms INTEGER,
                embedding_ms INTEGER,
                ranking_ms INTEGER,
                total_ms INTEGER,
                asset_state TEXT,
                query_cache_state TEXT,
                refinement_index INTEGER,
                conflict_count INTEGER,
                actual_conflict_count INTEGER,
                uncertain_conflict_count INTEGER,
                action TEXT,
                impression_count INTEGER,
                click_count INTEGER,
                add_count INTEGER,
                outcome TEXT,
                elapsed_ms INTEGER,
                elapsed_origin TEXT,
                department_relation TEXT,
                original_source TEXT,
                age_bucket TEXT,
                client_build_sha TEXT,
                client_artifact_version TEXT,
                client_artifact_bundle_id TEXT,
                client_model_revision TEXT,
                client_ranking_version TEXT,
                client_query_analysis_version TEXT,
                server_build_sha TEXT,
                server_artifact_version TEXT,
                server_model_revision TEXT,
                endpoint TEXT,
                status INTEGER,
                component TEXT,
                error_code TEXT
            )
            """
        )
        columns = {
            str(row[1]) for row in connection.execute("PRAGMA table_info(analytics_events)").fetchall()
        }
        migrations = {
            "event_id": "TEXT",
            "schema_version": "INTEGER NOT NULL DEFAULT 2",
            "asset_wait_ms": "INTEGER",
            "embedding_ms": "INTEGER",
            "ranking_ms": "INTEGER",
            "total_ms": "INTEGER",
            "asset_state": "TEXT",
            "query_cache_state": "TEXT",
            "actual_conflict_count": "INTEGER",
            "uncertain_conflict_count": "INTEGER",
            "impression_count": "INTEGER",
            "click_count": "INTEGER",
            "add_count": "INTEGER",
            "outcome": "TEXT",
            "elapsed_ms": "INTEGER",
            "elapsed_origin": "TEXT",
            "department_relation": "TEXT",
            "original_source": "TEXT",
            "age_bucket": "TEXT",
            "client_build_sha": "TEXT",
            "client_artifact_version": "TEXT",
            "client_artifact_bundle_id": "TEXT",
            "client_model_revision": "TEXT",
            "client_ranking_version": "TEXT",
            "client_query_analysis_version": "TEXT",
            "server_build_sha": "TEXT",
            "server_artifact_version": "TEXT",
            "server_model_revision": "TEXT",
        }
        for name, definition in migrations.items():
            if name not in columns:
                # Additive migrations keep existing deployments and queued
                # legacy events readable while new rows gain timing fields.
                connection.execute(f"ALTER TABLE analytics_events ADD COLUMN {name} {definition}")
        connection.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS analytics_events_event_id "
            "ON analytics_events(event_id) WHERE event_id IS NOT NULL"
        )
        connection.execute("CREATE INDEX IF NOT EXISTS analytics_events_day ON analytics_events(day, event)")
        connection.execute("CREATE INDEX IF NOT EXISTS analytics_events_course ON analytics_events(course_id)")
        connection.execute(
            "CREATE INDEX IF NOT EXISTS analytics_events_interaction ON analytics_events(interaction_id)"
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS analytics_daily_metrics (
                day TEXT NOT NULL,
                metric TEXT NOT NULL,
                dimension TEXT NOT NULL DEFAULT '',
                value REAL NOT NULL,
                PRIMARY KEY (day, metric, dimension)
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS analytics_daily_courses (
                day TEXT NOT NULL,
                course_id TEXT NOT NULL,
                impressions INTEGER NOT NULL DEFAULT 0,
                clicks INTEGER NOT NULL DEFAULT 0,
                adds INTEGER NOT NULL DEFAULT 0,
                removes INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (day, course_id)
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS analytics_daily_course_surface (
                day TEXT NOT NULL,
                course_id TEXT NOT NULL,
                surface TEXT NOT NULL,
                impressions INTEGER NOT NULL DEFAULT 0,
                clicks INTEGER NOT NULL DEFAULT 0,
                adds INTEGER NOT NULL DEFAULT 0,
                removes INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (day, course_id, surface)
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS analytics_daily_recommendation_runs (
                day TEXT NOT NULL,
                method TEXT NOT NULL,
                run_count INTEGER NOT NULL DEFAULT 0,
                zero_result_runs INTEGER NOT NULL DEFAULT 0,
                runs_with_impressions INTEGER NOT NULL DEFAULT 0,
                runs_with_click INTEGER NOT NULL DEFAULT 0,
                runs_with_add INTEGER NOT NULL DEFAULT 0,
                skipped_runs INTEGER NOT NULL DEFAULT 0,
                total_impressions INTEGER NOT NULL DEFAULT 0,
                total_clicks INTEGER NOT NULL DEFAULT 0,
                total_adds INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (day, method)
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS analytics_daily_search_funnel (
                day TEXT NOT NULL,
                search_mode TEXT NOT NULL,
                result_sets INTEGER NOT NULL DEFAULT 0,
                zero_result_sets INTEGER NOT NULL DEFAULT 0,
                result_impressions INTEGER NOT NULL DEFAULT 0,
                result_clicks INTEGER NOT NULL DEFAULT 0,
                result_sets_with_click INTEGER NOT NULL DEFAULT 0,
                result_sets_with_add INTEGER NOT NULL DEFAULT 0,
                adds_after_click INTEGER NOT NULL DEFAULT 0,
                finalized INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (day, search_mode)
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS analytics_daily_decision_time_buckets (
                day TEXT NOT NULL,
                origin TEXT NOT NULL,
                bucket TEXT NOT NULL,
                value INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (day, origin, bucket)
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS analytics_daily_research_dimensions (
                day TEXT NOT NULL,
                dimension TEXT NOT NULL,
                value TEXT NOT NULL,
                count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (day, dimension, value)
            )
            """
        )
        connection.execute(
            "CREATE TABLE IF NOT EXISTS analytics_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        )
        connection.execute(
            "INSERT OR REPLACE INTO analytics_meta(key, value) VALUES ('schema_version', ?)",
            (str(SCHEMA_VERSION),),
        )
        connection.commit()

    # -- ingest ------------------------------------------------------------- #

    def record(
        self,
        rows: Sequence[dict[str, Any]],
        *,
        user_agent: str | None,
        server_provenance: Mapping[str, Any] | None = None,
    ) -> int:
        """Persist already-validated rows. Returns how many were written."""
        if not rows:
            return 0
        now = _utc_now()
        received_at = now.isoformat(timespec="seconds")
        day = now.date().isoformat()
        browser, browser_major, operating_system, device = reduce_user_agent(user_agent)
        provenance = server_provenance or {}
        payload = [
            (
                row.get("event_id"),
                received_at,
                day,
                row["event"],
                row.get("schema_version", 2),
                row.get("session_id"),
                row.get("interaction_id"),
                browser,
                browser_major,
                operating_system,
                device,
                *(
                    {
                        **row,
                        "server_build_sha": _safe_provenance_token(provenance.get("server_build_sha")),
                        "server_artifact_version": _safe_provenance_token(provenance.get("server_artifact_version")),
                        "server_model_revision": _safe_provenance_token(provenance.get("server_model_revision")),
                    }.get(column)
                    for column in EVENT_COLUMNS
                ),
            )
            for row in rows
        ]
        with self._lock, self._connect() as connection:
            self._enforce_capacity(connection, incoming=len(payload))
            before = connection.total_changes
            try:
                connection.executemany(_INSERT_SQL, payload)
            except sqlite3.DatabaseError as exc:
                connection.rollback()
                if "full" in str(exc).lower() or "max_page_count" in str(exc).lower():
                    raise AnalyticsCapacityError("analytics storage capacity reached") from None
                raise
            written = connection.total_changes - before
            connection.commit()
        self._event_row_count += written
        return written

    def _database_size(self) -> int:
        """Return the SQLite file set size, including WAL sidecars."""
        total = 0
        for candidate in (self.path, Path(f"{self.path}-wal"), Path(f"{self.path}-shm")):
            try:
                total += candidate.stat().st_size
            except FileNotFoundError:
                pass
        return total

    def _delete_oldest(self, connection: sqlite3.Connection, count: int) -> int:
        if count <= 0 or self._event_row_count <= 0:
            return 0
        rows = connection.execute(
            "SELECT id, day FROM analytics_events ORDER BY id LIMIT ?", (count,)
        ).fetchall()
        if not rows:
            return 0
        # Preserve aggregates before raw rows are evicted. A later maintenance
        # pass will recompute the affected day if it still receives events.
        for day in {str(row[1]) for row in rows}:
            self._aggregate_day(connection, day)
        placeholders = ", ".join("?" for _ in rows)
        deleted = connection.execute(
            f"DELETE FROM analytics_events WHERE id IN ({placeholders})",
            tuple(int(row[0]) for row in rows),
        ).rowcount
        deleted = max(0, int(deleted))
        self._event_row_count = max(0, self._event_row_count - deleted)
        return deleted

    def _compact(self, connection: sqlite3.Connection) -> None:
        """Best-effort reclaim of pages after capacity eviction."""
        connection.commit()
        try:
            connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            connection.execute("VACUUM")
        except sqlite3.DatabaseError as exc:
            logger.warning("security_event=analytics_capacity_compaction_failure error_type=%s", type(exc).__name__)

    def _enforce_capacity(self, connection: sqlite3.Connection, *, incoming: int) -> int:
        """Evict oldest events before accepting a batch, without per-insert COUNT."""
        deleted = self._delete_oldest(
            connection,
            max(0, self._event_row_count + incoming - self.max_rows),
        )
        if self._database_size() > self.max_db_bytes:
            # Size pressure is checked on each write, but row counts are kept in
            # memory so the common path does not scan the table.
            target = max(1, min(self._event_row_count, max(1000, self._event_row_count // 10)))
            deleted += self._delete_oldest(connection, target)
            self._compact(connection)
        if self._database_size() > self.max_db_bytes:
            raise AnalyticsCapacityError("analytics storage capacity reached")
        if deleted:
            logger.warning("security_event=analytics_capacity_cleanup deleted_rows=%d", deleted)
        return deleted

    # -- maintenance -------------------------------------------------------- #

    def maintain(self, *, force: bool = False, now: datetime | None = None) -> dict[str, int]:
        """Aggregate, then expire.

        Called on startup and, at most every 15 minutes, from the ingest path.
        There is no scheduler and no background thread: at this volume the sweep
        is milliseconds, and a cron that can silently stop running is a worse
        retention guarantee than one that piggybacks on traffic.
        """
        import time as _time

        if not force and _time.monotonic() - self._last_maintenance < 900:
            return {}
        self._last_maintenance = _time.monotonic()
        moment = now or _utc_now()
        with self._lock, self._connect() as connection:
            days = [
                str(row[0])
                for row in connection.execute(
                    "SELECT DISTINCT day FROM analytics_events ORDER BY day"
                ).fetchall()
            ]
            for day in days:
                self._aggregate_day(connection, day)
            summary = self._expire(connection, moment)
            self._event_row_count = max(
                0, self._event_row_count - int(summary.get("deleted_rows", 0))
            )
            summary["capacity_deleted"] = self._enforce_capacity(connection, incoming=0)
            connection.commit()
        return {"aggregated_days": len(days), **summary}

    def _expire(self, connection: sqlite3.Connection, now: datetime) -> dict[str, int]:
        def cutoff(days: int) -> str:
            return (now - timedelta(days=days)).date().isoformat()

        identifiers = connection.execute(
            "UPDATE analytics_events SET session_id = NULL, interaction_id = NULL "
            "WHERE day < ? AND (session_id IS NOT NULL OR interaction_id IS NOT NULL)",
            (cutoff(self.retention.identifier_days),),
        ).rowcount
        diagnostics = connection.execute(
            "DELETE FROM analytics_events WHERE day < ? AND event IN (%s)"
            % ", ".join("?" * len(DIAGNOSTIC_EVENTS)),
            (cutoff(self.retention.diagnostics_days), *sorted(DIAGNOSTIC_EVENTS)),
        ).rowcount
        expired = connection.execute(
            "DELETE FROM analytics_events WHERE day < ?", (cutoff(self.retention.events_days),)
        ).rowcount
        return {
            "scrubbed_identifiers": max(0, identifiers),
            "deleted_diagnostics": max(0, diagnostics),
            "deleted_events": max(0, expired),
            "deleted_rows": max(0, diagnostics) + max(0, expired),
        }

    @staticmethod
    def _percentile(values: list[int], fraction: float) -> float:
        if not values:
            return 0.0
        ordered = sorted(values)
        index = min(len(ordered) - 1, max(0, round(fraction * (len(ordered) - 1))))
        return float(ordered[index])

    def _aggregate_phase_one_tables(self, connection: sqlite3.Connection, day: str) -> None:
        """Build Phase 1 durable aggregates without changing the legacy report.

        The normalized tables are deliberately separate from
        ``analytics_daily_courses``: the latter is a legacy mixed-source view
        that Phase 2 will stop using. Search linkage is finalized once the
        identifier retention window passes so a later maintenance sweep cannot
        erase the only permanent copy of the result-set funnel.
        """
        connection.execute("DELETE FROM analytics_daily_course_surface WHERE day = ?", (day,))
        connection.execute(
            """
            INSERT INTO analytics_daily_course_surface(
                day, course_id, surface, impressions, clicks, adds, removes
            )
            SELECT day, course_id, surface,
                   SUM(impressions), SUM(clicks), SUM(adds), SUM(removes)
            FROM (
                SELECT day, course_id,
                       CASE method
                         WHEN 'semantic' THEN 'semantic_recommendation'
                         WHEN 'schedule_slot' THEN 'schedule_slot'
                         ELSE 'unknown'
                       END AS surface,
                       1 AS impressions, 0 AS clicks, 0 AS adds, 0 AS removes
                FROM analytics_events
                WHERE day = ? AND event = 'recommendation_impression' AND course_id IS NOT NULL
                UNION ALL
                SELECT day, course_id,
                       CASE method
                         WHEN 'semantic' THEN 'semantic_recommendation'
                         WHEN 'schedule_slot' THEN 'schedule_slot'
                         ELSE 'unknown'
                       END AS surface,
                       0, 1, 0, 0
                FROM analytics_events
                WHERE day = ? AND event = 'recommendation_clicked' AND course_id IS NOT NULL
                UNION ALL
                SELECT day, course_id, 'search', 1, 0, 0, 0
                FROM analytics_events
                WHERE day = ? AND event = 'search_result_impression' AND course_id IS NOT NULL
                UNION ALL
                SELECT day, course_id, 'search', 0, 1, 0, 0
                FROM analytics_events
                WHERE day = ? AND event = 'search_result_clicked' AND course_id IS NOT NULL
                UNION ALL
                SELECT day, course_id,
                       CASE source
                         WHEN 'recommendation' THEN 'semantic_recommendation'
                         WHEN 'schedule_slot' THEN 'schedule_slot'
                         WHEN 'search' THEN 'search'
                         WHEN 'manual' THEN 'manual'
                         ELSE 'unknown'
                       END AS surface,
                       0, 0, 1, 0
                FROM analytics_events
                WHERE day = ? AND event = 'course_added' AND course_id IS NOT NULL
                UNION ALL
                SELECT day, course_id,
                       CASE original_source
                         WHEN 'recommendation' THEN 'semantic_recommendation'
                         WHEN 'schedule_slot' THEN 'schedule_slot'
                         WHEN 'search' THEN 'search'
                         WHEN 'manual' THEN 'manual'
                         ELSE 'unknown'
                       END AS surface,
                       0, 0, 0, 1
                FROM analytics_events
                WHERE day = ? AND event = 'course_removed' AND course_id IS NOT NULL
            )
            GROUP BY day, course_id, surface
            """,
            (day, day, day, day, day, day),
        )

        connection.execute("DELETE FROM analytics_daily_recommendation_runs WHERE day = ?", (day,))
        connection.execute(
            """
            INSERT INTO analytics_daily_recommendation_runs(
                day, method, run_count, zero_result_runs, runs_with_impressions,
                runs_with_click, runs_with_add, skipped_runs,
                total_impressions, total_clicks, total_adds
            )
            SELECT day, method,
                   COUNT(*),
                   SUM(outcome = 'zero_result'),
                   SUM(impression_count > 0),
                   SUM(click_count > 0),
                   SUM(add_count > 0),
                   SUM(outcome = 'results' AND result_count > 0 AND click_count = 0 AND add_count = 0),
                   SUM(impression_count), SUM(click_count), SUM(add_count)
            FROM analytics_events
            WHERE day = ? AND event = 'recommendation_run_completed'
            GROUP BY day, method
            """,
            (day,),
        )

        cutoff = (_utc_now() - timedelta(days=self.retention.identifier_days)).date().isoformat()
        funnel_exists = connection.execute(
            "SELECT 1 FROM analytics_daily_search_funnel WHERE day = ? LIMIT 1", (day,)
        ).fetchone()
        # Once interaction IDs are scrubbed, exact joins cannot be rebuilt from
        # raw rows. Keep the first finalized result-set aggregate intact.
        if not (day < cutoff and funnel_exists):
            connection.execute("DELETE FROM analytics_daily_search_funnel WHERE day = ?", (day,))
            for search_mode in sorted(SEARCH_MODES):
                result_sets = connection.execute(
                    """
                    SELECT COUNT(DISTINCT interaction_id) FROM analytics_events
                    WHERE day = ? AND event = 'search' AND search_mode = ?
                      AND interaction_id IS NOT NULL
                    """,
                    (day, search_mode),
                ).fetchone()[0]
                zero_result_sets = connection.execute(
                    """
                    SELECT COUNT(DISTINCT interaction_id) FROM analytics_events
                    WHERE day = ? AND event = 'zero_result' AND search_mode = ?
                      AND interaction_id IS NOT NULL
                    """,
                    (day, search_mode),
                ).fetchone()[0]
                result_impressions = connection.execute(
                    """
                    SELECT COUNT(*) FROM analytics_events
                    WHERE day = ? AND event = 'search_result_impression' AND search_mode = ?
                    """,
                    (day, search_mode),
                ).fetchone()[0]
                result_clicks = connection.execute(
                    """
                    SELECT COUNT(*) FROM analytics_events
                    WHERE day = ? AND event = 'search_result_clicked' AND search_mode = ?
                    """,
                    (day, search_mode),
                ).fetchone()[0]
                result_sets_with_click = connection.execute(
                    """
                    SELECT COUNT(DISTINCT interaction_id) FROM analytics_events
                    WHERE day = ? AND event = 'search_result_clicked' AND search_mode = ?
                      AND interaction_id IS NOT NULL
                    """,
                    (day, search_mode),
                ).fetchone()[0]
                result_sets_with_add = connection.execute(
                    """
                    SELECT COUNT(DISTINCT added.interaction_id)
                    FROM analytics_events AS added
                    WHERE added.day = ? AND added.event = 'course_added'
                      AND added.source = 'search' AND added.interaction_id IS NOT NULL
                      AND EXISTS (
                        SELECT 1 FROM analytics_events AS searched
                        WHERE searched.day = added.day
                          AND searched.event = 'search'
                          AND searched.search_mode = ?
                          AND searched.interaction_id = added.interaction_id
                      )
                    """,
                    (day, search_mode),
                ).fetchone()[0]
                adds_after_click = connection.execute(
                    """
                    SELECT COUNT(*)
                    FROM analytics_events AS added
                    WHERE added.day = ? AND added.event = 'course_added'
                      AND added.source = 'search' AND added.interaction_id IS NOT NULL
                      AND EXISTS (
                        SELECT 1 FROM analytics_events AS clicked
                        WHERE clicked.day = added.day
                          AND clicked.event = 'search_result_clicked'
                          AND clicked.search_mode = ?
                          AND clicked.interaction_id = added.interaction_id
                          AND clicked.course_id = added.course_id
                      )
                    """,
                    (day, search_mode),
                ).fetchone()[0]
                if any((result_sets, zero_result_sets, result_impressions, result_clicks, result_sets_with_click, result_sets_with_add, adds_after_click)):
                    connection.execute(
                        """
                        INSERT INTO analytics_daily_search_funnel(
                            day, search_mode, result_sets, zero_result_sets,
                            result_impressions, result_clicks, result_sets_with_click,
                            result_sets_with_add, adds_after_click, finalized
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            day,
                            search_mode,
                            int(result_sets),
                            int(zero_result_sets),
                            int(result_impressions),
                            int(result_clicks),
                            int(result_sets_with_click),
                            int(result_sets_with_add),
                            int(adds_after_click),
                            int(day < cutoff),
                        ),
                    )

        connection.execute("DELETE FROM analytics_daily_decision_time_buckets WHERE day = ?", (day,))
        connection.execute(
            """
            INSERT INTO analytics_daily_decision_time_buckets(day, origin, bucket, value)
            SELECT day, elapsed_origin, bucket, COUNT(*)
            FROM (
                SELECT day, elapsed_origin,
                       CASE
                         WHEN elapsed_ms < 1000 THEN 'under_1s'
                         WHEN elapsed_ms < 5000 THEN '1s_to_5s'
                         WHEN elapsed_ms < 10000 THEN '5s_to_10s'
                         WHEN elapsed_ms < 30000 THEN '10s_to_30s'
                         WHEN elapsed_ms < 60000 THEN '30s_to_60s'
                         WHEN elapsed_ms < 300000 THEN '1m_to_5m'
                         WHEN elapsed_ms < 900000 THEN '5m_to_15m'
                         WHEN elapsed_ms < 1800000 THEN '15m_to_30m'
                         WHEN elapsed_ms < 3600000 THEN '30m_to_60m'
                         ELSE '60m_to_120m'
                       END AS bucket
                FROM analytics_events
                WHERE day = ? AND elapsed_ms IS NOT NULL AND elapsed_origin IS NOT NULL
            )
            GROUP BY day, elapsed_origin, bucket
            """,
            (day,),
        )

        connection.execute("DELETE FROM analytics_daily_research_dimensions WHERE day = ?", (day,))
        connection.execute(
            """
            INSERT INTO analytics_daily_research_dimensions(day, dimension, value, count)
            SELECT day, dimension, value, COUNT(*)
            FROM (
                SELECT day, 'department_relation_impression' AS dimension,
                       COALESCE(department_relation, 'unknown') AS value
                FROM analytics_events
                WHERE day = ? AND event = 'recommendation_impression'
                UNION ALL
                SELECT day, 'department_relation_click',
                       COALESCE(department_relation, 'unknown')
                FROM analytics_events
                WHERE day = ? AND event = 'recommendation_clicked'
                UNION ALL
                SELECT day, 'department_relation_add',
                       COALESCE(department_relation, 'unknown')
                FROM analytics_events
                WHERE day = ? AND event = 'course_added'
                UNION ALL
                SELECT day, 'course_removed_original_source',
                       COALESCE(original_source, 'unknown')
                FROM analytics_events
                WHERE day = ? AND event = 'course_removed'
                UNION ALL
                SELECT day, 'course_removed_age_bucket',
                       COALESCE(age_bucket, 'unknown')
                FROM analytics_events
                WHERE day = ? AND event = 'course_removed'
                UNION ALL
                SELECT day, 'provenance_client_build_sha',
                       COALESCE(client_build_sha, 'unknown')
                FROM analytics_events
                WHERE day = ?
                UNION ALL
                SELECT day, 'provenance_client_artifact_version',
                       COALESCE(client_artifact_version, 'unknown')
                FROM analytics_events
                WHERE day = ?
                UNION ALL
                SELECT day, 'provenance_client_artifact_bundle_id',
                       COALESCE(client_artifact_bundle_id, 'unknown')
                FROM analytics_events
                WHERE day = ?
                UNION ALL
                SELECT day, 'provenance_client_model_revision',
                       COALESCE(client_model_revision, 'unknown')
                FROM analytics_events
                WHERE day = ?
                UNION ALL
                SELECT day, 'provenance_client_ranking_version',
                       COALESCE(client_ranking_version, 'unknown')
                FROM analytics_events
                WHERE day = ?
                UNION ALL
                SELECT day, 'provenance_client_query_analysis_version',
                       COALESCE(client_query_analysis_version, 'unknown')
                FROM analytics_events
                WHERE day = ?
                UNION ALL
                SELECT day, 'provenance_server_build_sha',
                       COALESCE(server_build_sha, 'unknown')
                FROM analytics_events
                WHERE day = ?
                UNION ALL
                SELECT day, 'provenance_server_artifact_version',
                       COALESCE(server_artifact_version, 'unknown')
                FROM analytics_events
                WHERE day = ?
                UNION ALL
                SELECT day, 'provenance_server_model_revision',
                       COALESCE(server_model_revision, 'unknown')
                FROM analytics_events
                WHERE day = ?
            )
            GROUP BY day, dimension, value
            """,
            (day,) * 14,
        )

    def _aggregate_day(self, connection: sqlite3.Connection, day: str) -> None:
        """Recompute one day's aggregates from raw. Idempotent by construction.

        Aggregates outlive raw events (§17), so they must be derivable at any
        time from whatever raw is still present — hence a full REPLACE of the
        day rather than an increment.
        """
        self._aggregate_phase_one_tables(connection, day)
        metrics: dict[tuple[str, str], float] = {}

        def put(metric: str, dimension: str, value: float) -> None:
            metrics[(metric, str(dimension))] = float(value)

        rows = connection.execute(
            "SELECT event, COUNT(*) FROM analytics_events WHERE day = ? GROUP BY event", (day,)
        ).fetchall()
        for event, count in rows:
            put("event_count", str(event), count)

        put(
            "sessions",
            "",
            connection.execute(
                "SELECT COUNT(DISTINCT session_id) FROM analytics_events WHERE day = ? AND session_id IS NOT NULL",
                (day,),
            ).fetchone()[0],
        )

        for column, metric in (
            ("page", "page_view"),
            ("feature", "feature_clicked"),
            ("filter_name", "filter_used"),
        ):
            event = metric
            for value, count in connection.execute(
                f"SELECT {column}, COUNT(*) FROM analytics_events "
                f"WHERE day = ? AND event = ? AND {column} IS NOT NULL GROUP BY {column}",
                (day, event),
            ):
                put(metric, str(value), count)

        for event, metric in (("search", "search"), ("zero_result", "zero_result")):
            for mode, count in connection.execute(
                "SELECT search_mode, COUNT(*) FROM analytics_events "
                "WHERE day = ? AND event = ? AND search_mode IS NOT NULL GROUP BY search_mode",
                (day, event),
            ):
                put(metric, str(mode), count)

        for bucket, count in connection.execute(
            """
            SELECT CASE
                     WHEN result_count = 0 THEN '0'
                     WHEN result_count BETWEEN 1 AND 5 THEN '1-5'
                     WHEN result_count BETWEEN 6 AND 20 THEN '6-20'
                     WHEN result_count BETWEEN 21 AND 100 THEN '21-100'
                     ELSE '100+'
                   END AS bucket,
                   COUNT(*)
            FROM analytics_events
            WHERE day = ? AND event = 'search' AND result_count IS NOT NULL
            GROUP BY bucket
            """,
            (day,),
        ):
            put("result_count_bucket", str(bucket), count)

        # Search latency is kept separate from the general API timings. The
        # recommendation surface ranks locally, so these phase percentiles are
        # the actionable view of the student's end-to-end wait. Missing values
        # are intentionally ignored for legacy/keyword events.
        for expression, metric in (
            ("COALESCE(total_ms, latency_ms)", "search_total_"),
            ("asset_wait_ms", "search_asset_wait_"),
            ("embedding_ms", "search_embedding_"),
            ("ranking_ms", "search_ranking_"),
        ):
            values = [
                int(value)
                for (value,) in connection.execute(
                    f"SELECT {expression} FROM analytics_events "
                    "WHERE day = ? AND event = 'search' AND search_mode = 'semantic' "
                    f"AND {expression} IS NOT NULL",
                    (day,),
                )
                if value is not None
            ]
            if not values:
                continue
            for suffix, fraction in (("p50", 0.50), ("p95", 0.95), ("p99", 0.99)):
                put(metric + suffix, "semantic", self._percentile(values, fraction))

        for column, metric in (
            ("asset_state", "search_asset_state"),
            ("query_cache_state", "search_query_cache_state"),
        ):
            for value, count in connection.execute(
                f"SELECT {column}, COUNT(*) FROM analytics_events "
                "WHERE day = ? AND event = 'search' AND search_mode = 'semantic' "
                f"AND {column} IS NOT NULL GROUP BY {column}",
                (day,),
            ):
                put(metric, str(value), count)

        refinements = connection.execute(
            "SELECT COUNT(*), COALESCE(MAX(refinement_index), 0) FROM analytics_events "
            "WHERE day = ? AND event = 'search_refined'",
            (day,),
        ).fetchone()
        put("refinement_events", "", refinements[0])
        put(
            "refinement_flows",
            "",
            connection.execute(
                "SELECT COUNT(DISTINCT interaction_id) FROM analytics_events "
                "WHERE day = ? AND event = 'search_refined' AND interaction_id IS NOT NULL",
                (day,),
            ).fetchone()[0],
        )

        for event, metric in (
            ("recommendation_impression", "rec_impressions_by_position"),
            ("recommendation_clicked", "rec_clicks_by_position"),
        ):
            for position, count in connection.execute(
                "SELECT position, COUNT(*) FROM analytics_events "
                "WHERE day = ? AND event = ? AND position IS NOT NULL GROUP BY position",
                (day, event),
            ):
                put(metric, str(position), count)

        for source, count in connection.execute(
            "SELECT source, COUNT(*) FROM analytics_events "
            "WHERE day = ? AND event = 'course_added' AND source IS NOT NULL GROUP BY source",
            (day,),
        ):
            put("course_added_source", str(source), count)

        for action, count in connection.execute(
            "SELECT action, COUNT(*) FROM analytics_events "
            "WHERE day = ? AND event = 'schedule_conflict_action' AND action IS NOT NULL GROUP BY action",
            (day,),
        ):
            put("conflict_action", str(action), count)

        for endpoint, count, errors in connection.execute(
            """
            SELECT endpoint, COUNT(*), SUM(CASE WHEN status >= 400 OR status = 0 THEN 1 ELSE 0 END)
            FROM analytics_events
            WHERE day = ? AND event = 'api_performance' AND endpoint IS NOT NULL
            GROUP BY endpoint
            """,
            (day,),
        ):
            put("api_requests", str(endpoint), count)
            put("api_errors", str(endpoint), errors or 0)
            latencies = [
                int(value)
                for (value,) in connection.execute(
                    "SELECT latency_ms FROM analytics_events "
                    "WHERE day = ? AND event = 'api_performance' AND endpoint = ? AND latency_ms IS NOT NULL",
                    (day, endpoint),
                )
                if value is not None
            ]
            put("api_latency_p50", str(endpoint), self._percentile(latencies, 0.50))
            put("api_latency_p95", str(endpoint), self._percentile(latencies, 0.95))
            put("api_latency_p99", str(endpoint), self._percentile(latencies, 0.99))

        for component, code, count in connection.execute(
            "SELECT component, error_code, COUNT(*) FROM analytics_events "
            "WHERE day = ? AND event = 'error' GROUP BY component, error_code",
            (day,),
        ):
            put("error", f"{component}:{code}", count)

        for browser, major, count in connection.execute(
            "SELECT browser, browser_major, COUNT(*) FROM analytics_events WHERE day = ? GROUP BY browser, browser_major",
            (day,),
        ):
            put("browser", f"{browser} {major if major is not None else '?'}", count)
        for device, count in connection.execute(
            "SELECT device, COUNT(*) FROM analytics_events WHERE day = ? GROUP BY device", (day,)
        ):
            put("device", str(device), count)

        connection.execute("DELETE FROM analytics_daily_metrics WHERE day = ?", (day,))
        connection.executemany(
            "INSERT INTO analytics_daily_metrics(day, metric, dimension, value) VALUES (?, ?, ?, ?)",
            [(day, metric, dimension, value) for (metric, dimension), value in metrics.items()],
        )

        connection.execute("DELETE FROM analytics_daily_courses WHERE day = ?", (day,))
        connection.execute(
            """
            INSERT INTO analytics_daily_courses(day, course_id, impressions, clicks, adds, removes)
            SELECT day, course_id,
                   SUM(event = 'recommendation_impression'),
                   SUM(event = 'recommendation_clicked'),
                   SUM(event = 'course_added'),
                   SUM(event = 'course_removed')
            FROM analytics_events
            WHERE day = ? AND course_id IS NOT NULL
            GROUP BY day, course_id
            """,
            (day,),
        )

    # -- reporting ---------------------------------------------------------- #

    @staticmethod
    def _histogram_percentile(histogram: Mapping[str, int], fraction: float) -> float | None:
        """Return a bounded representative percentile from fixed buckets.

        Daily decision-time percentiles are not additive.  This deliberately
        consumes the cross-day histogram and returns the midpoint of the bucket
        containing the requested rank; it never combines daily percentiles.
        """
        total = sum(max(0, int(histogram.get(label, 0))) for label, _, _ in DECISION_TIME_BUCKETS)
        if total <= 0:
            return None
        rank = min(total - 1, max(0, int(round(fraction * (total - 1)))))
        seen = 0
        for label, lower, upper in DECISION_TIME_BUCKETS:
            count = max(0, int(histogram.get(label, 0)))
            if rank < seen + count:
                return round((lower + upper) / 2, 1)
            seen += count
        return None

    @staticmethod
    def _research_distribution(
        rows: Sequence[tuple[str, int]],
        *,
        suppress_small: bool = False,
    ) -> dict[str, Any]:
        counts = {str(value): int(count) for value, count in rows}
        visible = counts
        suppressed_sample_size = 0
        suppressed_categories = 0
        if suppress_small:
            visible = {
                value: count
                for value, count in counts.items()
                if count >= MIN_RESEARCH_SLICE_N
            }
            suppressed_sample_size = sum(
                count for value, count in counts.items() if value not in visible
            )
            suppressed_categories = sum(1 for value in counts if value not in visible)
        return {
            "values": visible,
            "sample_size": sum(counts.values()),
            "suppressed": suppressed_sample_size > 0,
            "suppressed_sample_size": suppressed_sample_size,
            "suppressed_categories": suppressed_categories,
        }

    @staticmethod
    def _research_ratio(numerator: int | float, denominator: int | float) -> float | None:
        return round(float(numerator) / float(denominator), 4) if denominator else None

    def research_report(self, *, days: int = 30, course_limit: int = 25) -> dict[str, Any]:
        """Build the Phase 2 research-facing report from durable aggregates.

        This method intentionally never reads ``analytics_events``.  The
        maintenance pass may rebuild aggregates from raw events that are still
        inside retention, but the report itself remains valid after raw rows,
        identifiers and interaction links have expired.
        """
        self.maintain(force=True)
        end = _utc_now().date()
        start = (end - timedelta(days=max(1, days) - 1)).isoformat()
        end_day = end.isoformat()
        with self._lock, self._connect() as connection:
            data_start_row = connection.execute(
                """
                SELECT MIN(day) FROM (
                    SELECT day FROM analytics_daily_course_surface
                    UNION ALL SELECT day FROM analytics_daily_recommendation_runs
                    UNION ALL SELECT day FROM analytics_daily_search_funnel
                    UNION ALL SELECT day FROM analytics_daily_decision_time_buckets
                    UNION ALL SELECT day FROM analytics_daily_research_dimensions
                )
                """
            ).fetchone()
            data_start_date = str(data_start_row[0]) if data_start_row and data_start_row[0] else None

            surfaces: dict[str, dict[str, Any]] = {}
            for surface, impressions, clicks, adds, removes in connection.execute(
                """
                SELECT surface, SUM(impressions), SUM(clicks), SUM(adds), SUM(removes)
                FROM analytics_daily_course_surface
                WHERE day BETWEEN ? AND ?
                GROUP BY surface
                ORDER BY surface
                """,
                (start, end_day),
            ):
                impressions = int(impressions or 0)
                clicks = int(clicks or 0)
                adds = int(adds or 0)
                removes = int(removes or 0)
                surfaces[str(surface)] = {
                    "impressions": impressions,
                    "clicks": clicks,
                    "adds": adds,
                    "removes": removes,
                    "ctr": self._research_ratio(clicks, impressions),
                    "adoption": self._research_ratio(adds, impressions),
                    "click_to_add": self._research_ratio(adds, clicks),
                }

            course_surface = [
                {
                    "course_id": str(course_id),
                    "surface": str(surface),
                    "impressions": int(impressions or 0),
                    "clicks": int(clicks or 0),
                    "adds": int(adds or 0),
                    "removes": int(removes or 0),
                    "ctr": self._research_ratio(clicks or 0, impressions or 0),
                    "adoption": self._research_ratio(adds or 0, impressions or 0),
                    "click_to_add": self._research_ratio(adds or 0, clicks or 0),
                }
                for course_id, surface, impressions, clicks, adds, removes in connection.execute(
                    """
                    SELECT course_id, surface, SUM(impressions), SUM(clicks), SUM(adds), SUM(removes)
                    FROM analytics_daily_course_surface
                    WHERE day BETWEEN ? AND ?
                    GROUP BY course_id, surface
                    ORDER BY SUM(impressions) DESC, SUM(clicks) DESC, course_id, surface
                    LIMIT ?
                    """,
                    (start, end_day, max(1, min(500, course_limit))),
                )
            ]

            run_rows = [
                {
                    "method": str(method),
                    "run_count": int(run_count or 0),
                    "zero_result_runs": int(zero_result_runs or 0),
                    "runs_with_impressions": int(runs_with_impressions or 0),
                    "runs_with_click": int(runs_with_click or 0),
                    "runs_with_add": int(runs_with_add or 0),
                    "skipped_runs": int(skipped_runs or 0),
                    "total_impressions": int(total_impressions or 0),
                    "total_clicks": int(total_clicks or 0),
                    "total_adds": int(total_adds or 0),
                }
                for method, run_count, zero_result_runs, runs_with_impressions,
                runs_with_click, runs_with_add, skipped_runs, total_impressions,
                total_clicks, total_adds in connection.execute(
                    """
                    SELECT method, SUM(run_count), SUM(zero_result_runs),
                           SUM(runs_with_impressions), SUM(runs_with_click),
                           SUM(runs_with_add), SUM(skipped_runs),
                           SUM(total_impressions), SUM(total_clicks), SUM(total_adds)
                    FROM analytics_daily_recommendation_runs
                    WHERE day BETWEEN ? AND ?
                    GROUP BY method
                    ORDER BY method
                    """,
                    (start, end_day),
                )
            ]

            search_rows = [
                {
                    "search_mode": str(search_mode),
                    "result_sets": int(result_sets or 0),
                    "zero_result_sets": int(zero_result_sets or 0),
                    "result_impressions": int(result_impressions or 0),
                    "result_clicks": int(result_clicks or 0),
                    "result_sets_with_click": int(result_sets_with_click or 0),
                    "result_sets_with_add": int(result_sets_with_add or 0),
                    "adds_after_click": int(adds_after_click or 0),
                }
                for search_mode, result_sets, zero_result_sets, result_impressions,
                result_clicks, result_sets_with_click, result_sets_with_add,
                adds_after_click in connection.execute(
                    """
                    SELECT search_mode, SUM(result_sets), SUM(zero_result_sets),
                           SUM(result_impressions), SUM(result_clicks),
                           SUM(result_sets_with_click), SUM(result_sets_with_add),
                           SUM(adds_after_click)
                    FROM analytics_daily_search_funnel
                    WHERE day BETWEEN ? AND ?
                    GROUP BY search_mode
                    ORDER BY search_mode
                    """,
                    (start, end_day),
                )
            ]

            decision_rows = [
                (str(origin), str(bucket), int(value or 0))
                for origin, bucket, value in connection.execute(
                    """
                    SELECT origin, bucket, SUM(value)
                    FROM analytics_daily_decision_time_buckets
                    WHERE day BETWEEN ? AND ?
                    GROUP BY origin, bucket
                    """,
                    (start, end_day),
                )
            ]

            dimension_rows: dict[str, list[tuple[str, int]]] = {}
            for dimension, value, count in connection.execute(
                """
                SELECT dimension, value, SUM(count)
                FROM analytics_daily_research_dimensions
                WHERE day BETWEEN ? AND ?
                GROUP BY dimension, value
                ORDER BY dimension, value
                """,
                (start, end_day),
            ):
                dimension_rows.setdefault(str(dimension), []).append((str(value), int(count or 0)))

            legacy_mixed_row_count, legacy_mixed_adds = connection.execute(
                """
                SELECT COUNT(*), COALESCE(SUM(adds), 0)
                FROM analytics_daily_courses
                WHERE day BETWEEN ? AND ?
                """,
                (start, end_day),
            ).fetchone()
            legacy_mixed_row_count = int(legacy_mixed_row_count or 0)
            legacy_mixed_adds = int(legacy_mixed_adds or 0)

            unknown_surface_events = int(
                connection.execute(
                    """
                    SELECT COALESCE(SUM(impressions + clicks + adds + removes), 0)
                    FROM analytics_daily_course_surface
                    WHERE day BETWEEN ? AND ? AND surface = 'unknown'
                    """,
                    (start, end_day),
                ).fetchone()[0]
                or 0
            )

        run_totals = {
            key: sum(row[key] for row in run_rows)
            for key in (
                "run_count", "zero_result_runs", "runs_with_impressions", "runs_with_click",
                "runs_with_add", "skipped_runs", "total_impressions", "total_clicks", "total_adds",
            )
        }
        for row in run_rows:
            row.update({
                "skip_rate": self._research_ratio(row["skipped_runs"], row["run_count"]),
                "zero_result_rate": self._research_ratio(row["zero_result_runs"], row["run_count"]),
                "ctr": self._research_ratio(row["total_clicks"], row["total_impressions"]),
                "adoption": self._research_ratio(row["total_adds"], row["total_impressions"]),
                "click_to_add": self._research_ratio(row["total_adds"], row["total_clicks"]),
            })
        run_totals.update({
            "skip_rate": self._research_ratio(run_totals["skipped_runs"], run_totals["run_count"]),
            "zero_result_rate": self._research_ratio(run_totals["zero_result_runs"], run_totals["run_count"]),
            "ctr": self._research_ratio(run_totals["total_clicks"], run_totals["total_impressions"]),
            "adoption": self._research_ratio(run_totals["total_adds"], run_totals["total_impressions"]),
            "click_to_add": self._research_ratio(run_totals["total_adds"], run_totals["total_clicks"]),
        })

        search_totals = {
            key: sum(row[key] for row in search_rows)
            for key in (
                "result_sets", "zero_result_sets", "result_impressions", "result_clicks",
                "result_sets_with_click", "result_sets_with_add", "adds_after_click",
            )
        }
        for row in search_rows:
            row.update({
                "zero_result_rate": self._research_ratio(row["zero_result_sets"], row["result_sets"]),
                "ctr": self._research_ratio(row["result_clicks"], row["result_impressions"]),
                "result_set_click_rate": self._research_ratio(row["result_sets_with_click"], row["result_sets"]),
                "result_set_add_rate": self._research_ratio(row["result_sets_with_add"], row["result_sets"]),
                "adds_after_click_rate": self._research_ratio(row["adds_after_click"], row["result_clicks"]),
            })
        search_totals.update({
            "zero_result_rate": self._research_ratio(search_totals["zero_result_sets"], search_totals["result_sets"]),
            "ctr": self._research_ratio(search_totals["result_clicks"], search_totals["result_impressions"]),
            "result_set_click_rate": self._research_ratio(search_totals["result_sets_with_click"], search_totals["result_sets"]),
            "result_set_add_rate": self._research_ratio(search_totals["result_sets_with_add"], search_totals["result_sets"]),
            "adds_after_click_rate": self._research_ratio(search_totals["adds_after_click"], search_totals["result_clicks"]),
        })

        decision_by_origin: dict[str, dict[str, Any]] = {}
        for origin, bucket, value in decision_rows:
            entry = decision_by_origin.setdefault(origin, {"buckets": {}})
            entry["buckets"][bucket] = value
        for entry in decision_by_origin.values():
            histogram = entry["buckets"]
            entry["sample_size"] = sum(histogram.values())
            entry["p50_ms"] = self._histogram_percentile(histogram, 0.50)
            entry["p75_ms"] = self._histogram_percentile(histogram, 0.75)
            entry["p90_ms"] = self._histogram_percentile(histogram, 0.90)

        relation = {
            name: self._research_distribution(dimension_rows.get(dimension, []), suppress_small=True)
            for name, dimension in (
                ("impressions", "department_relation_impression"),
                ("clicks", "department_relation_click"),
                ("adds", "department_relation_add"),
            )
        }
        removals = {
            "by_source": self._research_distribution(
                dimension_rows.get("course_removed_original_source", [])
            ),
            "by_age_bucket": self._research_distribution(
                dimension_rows.get("course_removed_age_bucket", [])
            ),
        }
        provenance_fields = (
            "client_build_sha", "client_artifact_version", "client_artifact_bundle_id",
            "client_model_revision", "client_ranking_version", "client_query_analysis_version",
            "server_build_sha", "server_artifact_version", "server_model_revision",
        )
        provenance = {
            field: self._research_distribution(
                dimension_rows.get(f"provenance_{field}", []), suppress_small=True
            )
            for field in provenance_fields
        }
        missing_provenance = {
            field: {
                "missing": int(distribution["values"].get("unknown", 0))
                + int(distribution["suppressed_sample_size"] if "unknown" not in distribution["values"] else 0),
                "sample_size": distribution["sample_size"],
            }
            for field, distribution in provenance.items()
        }
        # Use the unsuppressed dimension rows for quality counts.  A hidden
        # value is still a valid aggregate; only its low-n label is withheld.
        for field in provenance_fields:
            all_counts = dict(dimension_rows.get(f"provenance_{field}", []))
            missing_provenance[field]["missing"] = int(all_counts.get("unknown", 0))

        suppressed_dimensions = [
            name
            for name, distribution in (
                *((f"department_relation.{name}", distribution) for name, distribution in relation.items()),
                *((f"provenance.{field}", distribution) for field, distribution in provenance.items()),
            )
            if distribution["suppressed"]
        ]
        legacy_warning = (
            "analytics_daily_courses.adds is legacy_mixed_adds and must not be used "
            "for recommendation adoption, churn, or source-specific research metrics."
        )
        return {
            "data_definition_version": RESEARCH_REPORT_VERSION,
            "data_start_date": data_start_date,
            "range": {"start": start, "end": end_day, "days": days},
            "retention": {
                "raw_events_days": self.retention.events_days,
                "diagnostic_days": self.retention.diagnostics_days,
                "identifier_days": self.retention.identifier_days,
                "aggregates": "retained",
                "raw_search_query": "never stored",
            },
            "backfill": {
                "source": "retained_raw_events_only",
                "estimated_values": False,
                "unresolved_history": "legacy_mixed_or_omitted_when_source_is_unprovable",
                "raw_event_retention_days": self.retention.events_days,
            },
            "data_quality": {
                "legacy_data": {
                    "present": legacy_mixed_row_count > 0,
                    "legacy_mixed_rows": legacy_mixed_row_count,
                    "legacy_mixed_adds": legacy_mixed_adds,
                    "warning": legacy_warning,
                },
                "unknown_source": {
                    "surface_events": unknown_surface_events,
                    "removal_source": removals["by_source"]["values"].get("unknown", 0),
                },
                "missing_provenance": missing_provenance,
                "insufficient_sample_size": {
                    "minimum_n": MIN_RESEARCH_SLICE_N,
                    "suppressed_dimensions": suppressed_dimensions,
                },
            },
            "legacy_mixed_metric_warning": legacy_warning,
            "overview": {
                "semantic_recommendation_ctr": surfaces.get("semantic_recommendation", {}).get("ctr"),
                "schedule_slot_ctr": surfaces.get("schedule_slot", {}).get("ctr"),
                "recommendation_run_skip_rate": run_totals["skip_rate"],
                "zero_result_run_rate": run_totals["zero_result_rate"],
            },
            "surfaces": surfaces,
            "courses": course_surface,
            "recommendation": {"by_method": run_rows, "totals": run_totals},
            "search": {"by_mode": search_rows, "totals": search_totals},
            "decision_time": {"by_origin": decision_by_origin, "bucket_definition": DECISION_TIME_BUCKETS},
            "removals": removals,
            "department_relation": relation,
            "provenance": provenance,
        }

    def report(self, *, days: int = 30, course_limit: int = 25) -> dict[str, Any]:
        """The dashboard's single data source. Reads aggregates, never raw."""
        self.maintain(force=True)
        end = _utc_now().date()
        start = (end - timedelta(days=max(1, days) - 1)).isoformat()
        end_day = end.isoformat()
        with self._lock, self._connect() as connection:
            metrics: dict[str, dict[str, float]] = {}
            for metric, dimension, value in connection.execute(
                "SELECT metric, dimension, SUM(value) FROM analytics_daily_metrics "
                "WHERE day BETWEEN ? AND ? GROUP BY metric, dimension",
                (start, end_day),
            ):
                metrics.setdefault(str(metric), {})[str(dimension)] = float(value)
            # Percentiles are not additive; take the worst day in the window
            # rather than summing, which would be meaningless.
            for metric in (
                "api_latency_p50", "api_latency_p95", "api_latency_p99",
                "search_total_p50", "search_total_p95", "search_total_p99",
                "search_asset_wait_p50", "search_asset_wait_p95", "search_asset_wait_p99",
                "search_embedding_p50", "search_embedding_p95", "search_embedding_p99",
                "search_ranking_p50", "search_ranking_p95", "search_ranking_p99",
            ):
                metrics[metric] = {}
                for dimension, value in connection.execute(
                    "SELECT dimension, MAX(value) FROM analytics_daily_metrics "
                    "WHERE day BETWEEN ? AND ? AND metric = ? GROUP BY dimension",
                    (start, end_day, metric),
                ):
                    metrics[metric][str(dimension)] = float(value)

            courses = [
                {
                    "course_id": str(course_id),
                    "impressions": int(impressions),
                    "clicks": int(clicks),
                    "adds": int(adds),
                    "removes": int(removes),
                    "ctr": round(clicks / impressions, 4) if impressions else None,
                    "adoption": round(adds / impressions, 4) if impressions else None,
                    "click_to_add": round(adds / clicks, 4) if clicks else None,
                }
                for course_id, impressions, clicks, adds, removes in connection.execute(
                    """
                    SELECT course_id, SUM(impressions), SUM(clicks), SUM(adds), SUM(removes)
                    FROM analytics_daily_courses
                    WHERE day BETWEEN ? AND ?
                    GROUP BY course_id
                    ORDER BY SUM(impressions) DESC, SUM(clicks) DESC
                    LIMIT ?
                    """,
                    (start, end_day, max(1, min(500, course_limit))),
                )
            ]
            daily = [
                {"day": str(day), "value": float(value)}
                for day, value in connection.execute(
                    "SELECT day, SUM(value) FROM analytics_daily_metrics "
                    "WHERE day BETWEEN ? AND ? AND metric = 'event_count' GROUP BY day ORDER BY day",
                    (start, end_day),
                )
            ]
            adds_from_recommendation = float(
                metrics.get("course_added_source", {}).get("recommendation", 0.0)
            )
            legacy_data_start_row = connection.execute(
                "SELECT MIN(day) FROM analytics_daily_metrics WHERE day BETWEEN ? AND ?",
                (start, end_day),
            ).fetchone()
            legacy_data_start_date = (
                str(legacy_data_start_row[0])
                if legacy_data_start_row and legacy_data_start_row[0]
                else None
            )

        counts = metrics.get("event_count", {})
        impressions = counts.get("recommendation_impression", 0.0)
        clicks = counts.get("recommendation_clicked", 0.0)
        searches = counts.get("search", 0.0)
        zero = counts.get("zero_result", 0.0)
        sessions = sum(metrics.get("sessions", {}).values())
        refinement_events = sum(metrics.get("refinement_events", {}).values())
        refinement_flows = sum(metrics.get("refinement_flows", {}).values())

        def ratio(numerator: float, denominator: float) -> float | None:
            return round(numerator / denominator, 4) if denominator else None

        return {
            "data_definition_version": LEGACY_REPORT_VERSION,
            "data_start_date": legacy_data_start_date,
            "range": {"start": start, "end": end_day, "days": days},
            "retention": {
                "raw_events_days": self.retention.events_days,
                "diagnostic_days": self.retention.diagnostics_days,
                "identifier_days": self.retention.identifier_days,
                "aggregates": "retained",
                "raw_search_query": "never stored",
            },
            "overview": {
                "page_views": counts.get("page_view", 0.0),
                "sessions": sessions,
                "searches": searches,
                "searches_per_session": ratio(searches, sessions),
                "zero_result_rate": ratio(zero, searches),
                "search_refinement_rate": ratio(refinement_events, refinement_flows),
                "recommendation_impressions": impressions,
                "recommendation_clicks": clicks,
                "recommendation_ctr": ratio(clicks, impressions),
                "recommendation_adoption_rate": ratio(adds_from_recommendation, impressions),
                "click_to_add_rate": ratio(adds_from_recommendation, clicks),
                "api_error_rate": ratio(
                    sum(metrics.get("api_errors", {}).values()),
                    sum(metrics.get("api_requests", {}).values()),
                ),
                "error_events": counts.get("error", 0.0),
            },
            "events": counts,
            "pages": metrics.get("page_view", {}),
            "features": metrics.get("feature_clicked", {}),
            "filters": metrics.get("filter_used", {}),
            "search": {
                "by_mode": metrics.get("search", {}),
                "zero_result_by_mode": metrics.get("zero_result", {}),
                "result_count_buckets": metrics.get("result_count_bucket", {}),
                "asset_state": metrics.get("search_asset_state", {}),
                "query_cache_state": metrics.get("search_query_cache_state", {}),
                "timing": {
                    "total_ms": {
                        "p50": metrics.get("search_total_p50", {}).get("semantic", 0.0),
                        "p95": metrics.get("search_total_p95", {}).get("semantic", 0.0),
                        "p99": metrics.get("search_total_p99", {}).get("semantic", 0.0),
                    },
                    "asset_wait_ms": {
                        "p50": metrics.get("search_asset_wait_p50", {}).get("semantic", 0.0),
                        "p95": metrics.get("search_asset_wait_p95", {}).get("semantic", 0.0),
                        "p99": metrics.get("search_asset_wait_p99", {}).get("semantic", 0.0),
                    },
                    "embedding_ms": {
                        "p50": metrics.get("search_embedding_p50", {}).get("semantic", 0.0),
                        "p95": metrics.get("search_embedding_p95", {}).get("semantic", 0.0),
                        "p99": metrics.get("search_embedding_p99", {}).get("semantic", 0.0),
                    },
                    "ranking_ms": {
                        "p50": metrics.get("search_ranking_p50", {}).get("semantic", 0.0),
                        "p95": metrics.get("search_ranking_p95", {}).get("semantic", 0.0),
                        "p99": metrics.get("search_ranking_p99", {}).get("semantic", 0.0),
                    },
                },
                "refinement_events": refinement_events,
                "refinement_flows": refinement_flows,
            },
            "recommendation": {
                "impressions_by_position": metrics.get("rec_impressions_by_position", {}),
                "clicks_by_position": metrics.get("rec_clicks_by_position", {}),
                "adds_by_source": metrics.get("course_added_source", {}),
                "skipped": counts.get("recommendation_skipped", 0.0),
            },
            "conflicts": {
                "occurrences": counts.get("schedule_conflict", 0.0),
                "actions": metrics.get("conflict_action", {}),
            },
            "api": {
                "requests": metrics.get("api_requests", {}),
                "errors": metrics.get("api_errors", {}),
                "p50": metrics.get("api_latency_p50", {}),
                "p95": metrics.get("api_latency_p95", {}),
                "p99": metrics.get("api_latency_p99", {}),
            },
            "errors": metrics.get("error", {}),
            "clients": {"browsers": metrics.get("browser", {}), "devices": metrics.get("device", {})},
            "courses": courses,
            "daily_events": daily,
        }


def build_store(path: str | os.PathLike[str] | None = None) -> AnalyticsStore | None:
    """Create the store unless analytics is switched off for this deployment."""
    if os.environ.get("FJU_ANALYTICS_ENABLED", "1").strip().lower() in {"0", "false", "no", "off"}:
        return None
    target = Path(path or os.environ.get("FJU_ANALYTICS_DB", "data/runtime/analytics.sqlite3"))
    return AnalyticsStore(target)


def validate_batch(
    events: Iterable[Any],
    *,
    course_exists: Callable[[str], bool] | None = None,
    require_event_id: bool = False,
    derive_event_id: bool = False,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Validate a whole batch, keeping the good rows and reporting the rest.

    One malformed event does not discard the batch: the client is fire-and-forget
    and cannot retry usefully, so dropping 39 valid rows because of a 40th would
    lose real data for no privacy gain. A structurally hostile payload — a
    denylisted key, an oversized batch — is still rejected outright by the
    caller before it gets here.
    """
    accepted: list[dict[str, Any]] = []
    rejected: list[str] = []
    for event in events:
        try:
            accepted.append(
                validate_event(
                    event,
                    course_exists=course_exists,
                    require_event_id=require_event_id,
                    derive_event_id=derive_event_id,
                )
            )
        except AnalyticsRejection as error:
            rejected.append(str(error))
    return accepted, rejected
