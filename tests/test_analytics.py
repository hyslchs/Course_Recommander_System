from __future__ import annotations

import re
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from fju_outline.analytics import (
    AnalyticsRejection,
    AnalyticsStore,
    Retention,
    assert_no_forbidden_keys,
    reduce_user_agent,
    validate_batch,
    validate_event,
)
from fju_outline.artifacts import build_artifacts
from fju_outline.web import ArtifactStore, create_app

from test_artifacts import FakeEncoder, _record


class FakeQueryEncoder:
    model_name = "fake/test-model"
    model_revision = "test-revision"

    def encode(self, text: str) -> np.ndarray:
        return np.array([1.0, 0.0, 0.0], dtype=np.float32)

    def encode_many(self, texts: list[str]) -> np.ndarray:
        return np.stack([self.encode(text) for text in texts])


def _store(tmp_path: Path, **retention) -> AnalyticsStore:
    return AnalyticsStore(
        tmp_path / "analytics.sqlite3",
        retention=Retention(**retention) if retention else Retention(),
    )


def _client(tmp_path: Path, *, token: str | None = None, monkeypatch=None) -> TestClient:
    output = tmp_path / "artifacts"
    build_artifacts([_record("1", "資料科學")], output, encoder=FakeEncoder(), year=115, semester=1)
    if token is not None:
        assert monkeypatch is not None
        monkeypatch.setenv("FJU_ANALYTICS_ADMIN_TOKEN", token)
    app = create_app(
        store=ArtifactStore(output),
        query_encoder=FakeQueryEncoder(),
        analytics_store=_store(tmp_path),
        load_runtime=False,
    )
    return TestClient(app)


# --------------------------------------------------------------------------- #
# Schema validation
# --------------------------------------------------------------------------- #

def test_valid_event_is_projected_onto_typed_columns():
    row = validate_event({
        "event": "search",
        "timestamp": "2026-08-26T08:20:31Z",
        "page": "course_search",
        "session_id": "tmp_a8f219aa",
        "interaction_id": "search_abc123",
        "data": {"search_mode": "semantic", "query_length": 12, "result_count": 27, "latency_ms": 328},
    })
    assert row == {
        "event": "search",
        "page": "course_search",
        "session_id": "tmp_a8f219aa",
        "interaction_id": "search_abc123",
        "search_mode": "semantic",
        "query_length": 12,
        "result_count": 27,
        "latency_ms": 328,
    }
    # The client clock is accepted for payload compatibility and then dropped;
    # the stored time is the server's.
    assert "timestamp" not in row


def test_search_timing_fields_are_validated_without_accepting_query_text():
    row = validate_event({
        "event": "search",
        "data": {
            "search_mode": "semantic",
            "query_length": 8,
            "result_count": 20,
            "latency_ms": 1800,
            "asset_wait_ms": 900,
            "embedding_ms": 700,
            "ranking_ms": 200,
            "total_ms": 1800,
            "asset_state": "prefetched",
            "query_cache_state": "miss",
        },
    })
    assert row["asset_wait_ms"] == 900
    assert row["embedding_ms"] == 700
    assert row["ranking_ms"] == 200
    assert row["total_ms"] == 1800
    assert row["asset_state"] == "prefetched"
    assert row["query_cache_state"] == "miss"
    with pytest.raises(AnalyticsRejection):
        validate_event({
            "event": "search",
            "data": {
                "search_mode": "semantic", "query_length": 8, "result_count": 1,
                "latency_ms": 10, "query": "不可保存",
            },
        })


def test_search_timing_percentiles_and_states_are_reported(tmp_path):
    store = _store(tmp_path)
    store.record(
        [
            {
                "event": "search", "search_mode": "semantic", "query_length": 4,
                "result_count": 3, "latency_ms": total, "total_ms": total,
                "asset_wait_ms": asset, "embedding_ms": embedding, "ranking_ms": ranking,
                "asset_state": state, "query_cache_state": cache,
            }
            for total, asset, embedding, ranking, state, cache in (
                (1000, 100, 700, 200, "prefetched", "miss"),
                (2000, 200, 1200, 300, "indexed_db", "hit"),
                (4000, 500, 2800, 500, "network", "miss"),
            )
        ],
        user_agent=None,
    )
    report = store.report(days=1)
    timing = report["search"]["timing"]
    assert timing["total_ms"]["p50"] == 2000
    assert timing["total_ms"]["p95"] == 4000
    assert timing["embedding_ms"]["p95"] == 2800
    assert report["search"]["asset_state"] == {"indexed_db": 1.0, "network": 1.0, "prefetched": 1.0}
    assert report["search"]["query_cache_state"] == {"hit": 1.0, "miss": 2.0}


def test_unknown_event_is_rejected():
    with pytest.raises(AnalyticsRejection):
        validate_event({"event": "anything", "data": {"whatever": "..."}})


def test_unknown_property_on_a_known_event_is_rejected():
    with pytest.raises(AnalyticsRejection):
        validate_event({"event": "zero_result", "data": {"search_mode": "semantic", "raw": "x"}})


def test_unknown_top_level_property_is_rejected():
    with pytest.raises(AnalyticsRejection):
        validate_event({"event": "page_view", "user_id": "u1", "data": {"page": "schedule"}})


def test_enum_values_outside_the_allowlist_are_rejected():
    with pytest.raises(AnalyticsRejection):
        validate_event({"event": "page_view", "data": {"page": "/explore?q=my+name"}})
    with pytest.raises(AnalyticsRejection):
        validate_event({"event": "feature_clicked", "data": {"feature": "按我看更多"}})


def test_out_of_range_numbers_are_rejected():
    with pytest.raises(AnalyticsRejection):
        validate_event({"event": "search_refined", "data": {"refinement_index": 10_000}})


def test_free_text_cannot_be_smuggled_through_filter_value():
    with pytest.raises(AnalyticsRejection):
        validate_event({
            "event": "filter_used",
            "data": {"filter": "weekday", "value": "王小明 0912345678"},
        })
    assert validate_event({"event": "filter_used", "data": {"filter": "weekday", "value": "wed"}})[
        "filter_value"
    ] == "wed"


def test_course_id_must_exist_in_the_catalog():
    exists = {"D123456"}.__contains__
    row = validate_event(
        {
            "event": "recommendation_impression",
            "interaction_id": "rec_3f82abc",
            "data": {"course_id": "D123456", "position": 3, "method": "semantic"},
        },
        course_exists=exists,
    )
    assert row["course_id"] == "D123456"
    with pytest.raises(AnalyticsRejection):
        validate_event(
            {
                "event": "recommendation_impression",
                "interaction_id": "rec_3f82abc",
                "data": {"course_id": "NOT_A_COURSE", "position": 3, "method": "semantic"},
            },
            course_exists=exists,
        )


def test_identifiers_must_match_the_short_lived_shapes():
    with pytest.raises(AnalyticsRejection):
        validate_event({"event": "page_view", "session_id": "user-1234", "data": {"page": "schedule"}})
    with pytest.raises(AnalyticsRejection):
        validate_event(
            {"event": "page_view", "interaction_id": "persistent_device_uuid_v4", "data": {"page": "schedule"}}
        )


@pytest.mark.parametrize(
    "payload",
    [
        {"events": [{"event": "page_view", "data": {"page": "schedule"}}], "email": "a@b.c"},
        {"events": [{"event": "page_view", "data": {"page": "schedule"}, "student_id": "405123456"}]},
        {"events": [{"event": "page_view", "data": {"page": "schedule"}}], "ip": "140.136.1.1"},
        {"events": [{"event": "page_view", "data": {"page": "schedule"}}], "token": "Bearer x"},
        {"events": [{"event": "page_view", "data": {"page": "schedule"}}], "schedule": [1, 2, 3]},
        {"events": [{"event": "search", "data": {"raw_query": "我的病歷"}}]},
    ],
)
def test_denylisted_properties_are_refused(payload):
    with pytest.raises(AnalyticsRejection):
        assert_no_forbidden_keys(payload)


def test_validate_batch_keeps_good_rows_and_reports_the_rest():
    accepted, rejected = validate_batch([
        {"event": "page_view", "data": {"page": "schedule"}},
        {"event": "nope", "data": {}},
        {"event": "zero_result", "data": {"search_mode": "keyword"}},
    ])
    assert [row["event"] for row in accepted] == ["page_view", "zero_result"]
    assert len(rejected) == 1


# --------------------------------------------------------------------------- #
# User-Agent reduction
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize(
    "user_agent,expected",
    [
        (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
            ("Chrome", 151, "Windows", "desktop"),
        ),
        (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1",
            ("Safari", 18, "iOS", "mobile"),
        ),
        (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0",
            ("Edge", 151, "Windows", "desktop"),
        ),
        (
            "Mozilla/5.0 (Android 14; Mobile; rv:135.0) Gecko/135.0 Firefox/135.0",
            ("Firefox", 135, "Android", "mobile"),
        ),
        ("", ("Unknown", None, "Unknown", "unknown")),
    ],
)
def test_user_agent_is_reduced_to_four_coarse_values(user_agent, expected):
    assert reduce_user_agent(user_agent) == expected


def test_user_agent_reduction_keeps_no_raw_string(tmp_path):
    store = _store(tmp_path)
    raw = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15"
    store.record([{"event": "page_view", "page": "schedule"}], user_agent=raw)
    with store._connect() as connection:  # noqa: SLF001 - asserting on storage is the point
        columns = {row[1] for row in connection.execute("PRAGMA table_info(analytics_events)")}
        assert "user_agent" not in columns
        row = connection.execute("SELECT browser, browser_major, os, device FROM analytics_events").fetchone()
    assert row == ("Safari", 17, "macOS", "desktop")


# --------------------------------------------------------------------------- #
# Storage, retention, aggregation
# --------------------------------------------------------------------------- #

def test_events_are_stored_in_typed_columns_without_a_json_blob(tmp_path):
    store = _store(tmp_path)
    accepted, _ = validate_batch(
        [
            {"event": "search", "session_id": "tmp_aaaaaa", "interaction_id": "search_abcd",
             "data": {"search_mode": "semantic", "query_length": 5, "result_count": 0, "latency_ms": 120}},
            {"event": "zero_result", "interaction_id": "search_abcd", "data": {"search_mode": "semantic"}},
        ]
    )
    assert store.record(accepted, user_agent=None) == 2
    with store._connect() as connection:  # noqa: SLF001
        columns = {row[1] for row in connection.execute("PRAGMA table_info(analytics_events)")}
    assert not columns & {"data", "payload", "json", "body", "properties"}


def test_duplicate_event_id_is_ignored_and_does_not_poison_aggregates(tmp_path):
    store = _store(tmp_path)
    event = {
        "event": "page_view",
        "event_id": "evt_" + "a" * 32,
        "timestamp": "2026-08-27T08:20:31Z",
        "data": {"page": "schedule"},
    }
    accepted, rejected = validate_batch([event])
    assert not rejected
    assert store.record(accepted, user_agent=None) == 1
    assert store.record(accepted, user_agent=None) == 0
    assert store.report(days=7)["events"] == {"page_view": 1.0}


def test_http_retry_of_the_same_event_is_idempotent(tmp_path):
    payload = {
        "events": [{
            "event": "page_view",
            "timestamp": "2026-08-27T08:20:31Z",
            "data": {"page": "schedule"},
        }]
    }
    with _client(tmp_path) as client:
        first = client.post("/api/v1/analytics/events", json=payload)
        retry = client.post("/api/v1/analytics/events", json=payload)
        assert first.status_code == retry.status_code == 202
        assert first.json() == {"accepted": 1, "rejected": 0}
        assert retry.json() == {"accepted": 0, "rejected": 0}


def test_capacity_row_ceiling_evicts_oldest_events_without_failure(tmp_path):
    store = AnalyticsStore(
        tmp_path / "analytics.sqlite3",
        retention=Retention(),
        max_rows=3,
        max_db_bytes=64 * 1024 * 1024,
    )
    rows = [{"event": "page_view", "page": "schedule"} for _ in range(3)]
    assert store.record(rows, user_agent=None) == 3
    assert store.record([{"event": "page_view", "page": "recommendation"}], user_agent=None) == 1
    with store._connect() as connection:  # noqa: SLF001
        count = connection.execute("SELECT COUNT(*) FROM analytics_events").fetchone()[0]
        pages = {row[0] for row in connection.execute("SELECT page FROM analytics_events")}
    assert count == 3
    assert pages == {"schedule", "recommendation"}


def test_v1_analytics_database_gets_event_id_column_without_data_loss(tmp_path):
    path = tmp_path / "legacy-analytics.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.execute(
            "CREATE TABLE analytics_events ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, received_at TEXT NOT NULL, day TEXT NOT NULL, "
            "event TEXT NOT NULL, session_id TEXT, interaction_id TEXT, browser TEXT, browser_major INTEGER, "
            "os TEXT, device TEXT, page TEXT, course_id TEXT, position INTEGER, method TEXT, source TEXT, "
            "feature TEXT, filter_name TEXT, filter_value TEXT, search_mode TEXT, query_length INTEGER, "
            "result_count INTEGER, latency_ms INTEGER, refinement_index INTEGER, conflict_count INTEGER, "
            "action TEXT, endpoint TEXT, status INTEGER, component TEXT, error_code TEXT)"
        )
        connection.execute(
            "INSERT INTO analytics_events(received_at, day, event, page) "
            "VALUES ('2026-08-27T08:20:31+00:00', '2026-08-27', 'page_view', 'schedule')"
        )
        connection.commit()

    store = AnalyticsStore(path, retention=Retention())
    with store._connect() as connection:  # noqa: SLF001
        columns = {row[1] for row in connection.execute("PRAGMA table_info(analytics_events)")}
        count = connection.execute("SELECT COUNT(*) FROM analytics_events").fetchone()[0]
        index_names = {row[1] for row in connection.execute("PRAGMA index_list(analytics_events)")}
    assert "event_id" in columns
    assert count == 1
    assert "analytics_events_event_id" in index_names


def test_identifiers_are_scrubbed_before_raw_events_expire(tmp_path):
    store = _store(tmp_path, events_days=180, diagnostics_days=90, identifier_days=7)
    store.record(
        [{"event": "page_view", "page": "schedule", "session_id": "tmp_aaaaaa", "interaction_id": "rec_abcd"}],
        user_agent=None,
    )
    old = (datetime.now(timezone.utc) - timedelta(days=10)).date().isoformat()
    with store._connect() as connection:  # noqa: SLF001
        connection.execute("UPDATE analytics_events SET day = ?", (old,))
        connection.commit()

    store.maintain(force=True)

    with store._connect() as connection:  # noqa: SLF001
        row = connection.execute("SELECT session_id, interaction_id, event FROM analytics_events").fetchone()
    # The row survives for aggregate use; the two things that could link it to
    # another row do not.
    assert row == (None, None, "page_view")


def test_expired_raw_events_are_deleted_but_aggregates_survive(tmp_path):
    store = _store(tmp_path, events_days=30, diagnostics_days=10, identifier_days=7)
    store.record([{"event": "page_view", "page": "schedule"}], user_agent=None)
    store.record(
        [{"event": "api_performance", "endpoint": "courses", "latency_ms": 40, "status": 200}],
        user_agent=None,
    )
    old = (datetime.now(timezone.utc) - timedelta(days=40)).date().isoformat()
    stale = (datetime.now(timezone.utc) - timedelta(days=20)).date().isoformat()
    with store._connect() as connection:  # noqa: SLF001
        connection.execute("UPDATE analytics_events SET day = ? WHERE event = 'page_view'", (old,))
        connection.execute("UPDATE analytics_events SET day = ? WHERE event = 'api_performance'", (stale,))
        connection.commit()

    store.maintain(force=True)

    with store._connect() as connection:  # noqa: SLF001
        assert connection.execute("SELECT COUNT(*) FROM analytics_events").fetchone()[0] == 0
        aggregated = connection.execute(
            "SELECT day, metric, dimension, value FROM analytics_daily_metrics "
            "WHERE metric = 'event_count' ORDER BY day"
        ).fetchall()
    assert (old, "event_count", "page_view", 1.0) in aggregated
    assert (stale, "event_count", "api_performance", 1.0) in aggregated


def test_report_computes_the_required_metrics(tmp_path):
    store = _store(tmp_path)
    events = [
        {"event": "page_view", "page": "recommendation", "session_id": "tmp_session1"},
        {"event": "search", "session_id": "tmp_session1", "interaction_id": "search_aaaa",
         "search_mode": "semantic", "query_length": 8, "result_count": 10, "latency_ms": 300},
        {"event": "search", "session_id": "tmp_session1", "interaction_id": "search_bbbb",
         "search_mode": "semantic", "query_length": 3, "result_count": 0, "latency_ms": 210},
        {"event": "zero_result", "session_id": "tmp_session1", "interaction_id": "search_bbbb",
         "search_mode": "semantic"},
        {"event": "search_refined", "session_id": "tmp_session1", "interaction_id": "flow_aaaa",
         "refinement_index": 1},
    ]
    events += [
        {"event": "recommendation_impression", "interaction_id": "rec_aaaa", "course_id": f"C{index}",
         "position": index + 1, "method": "semantic"}
        for index in range(4)
    ]
    events += [
        {"event": "recommendation_clicked", "interaction_id": "rec_aaaa", "course_id": "C0", "position": 1},
        {"event": "course_added", "interaction_id": "rec_aaaa", "course_id": "C0", "source": "recommendation"},
        {"event": "course_removed", "course_id": "C0"},
        {"event": "api_performance", "endpoint": "query_embedding", "latency_ms": 100, "status": 200},
        {"event": "api_performance", "endpoint": "query_embedding", "latency_ms": 900, "status": 500},
        {"event": "error", "component": "recommendation", "error_code": "EMBEDDING_REQUEST_FAILED"},
    ]
    store.record(events, user_agent="Mozilla/5.0 (Windows NT 10.0) Chrome/151.0.0.0 Safari/537.36")

    report = store.report(days=7)
    overview = report["overview"]
    assert overview["sessions"] == 1
    assert overview["searches"] == 2
    assert overview["zero_result_rate"] == 0.5
    assert overview["recommendation_ctr"] == 0.25          # 1 click / 4 impressions
    assert overview["recommendation_adoption_rate"] == 0.25  # 1 add / 4 impressions
    assert overview["click_to_add_rate"] == 1.0
    assert overview["api_error_rate"] == 0.5
    assert report["api"]["p50"]["query_embedding"] in (100.0, 900.0)
    assert report["api"]["p99"]["query_embedding"] == 900.0
    assert report["errors"] == {"recommendation:EMBEDDING_REQUEST_FAILED": 1.0}
    assert report["clients"]["devices"] == {"desktop": float(len(events))}

    top = {row["course_id"]: row for row in report["courses"]}
    assert top["C0"]["impressions"] == 1 and top["C0"]["clicks"] == 1
    assert top["C0"]["adds"] == 1 and top["C0"]["removes"] == 1


def test_aggregation_is_idempotent(tmp_path):
    store = _store(tmp_path)
    store.record([{"event": "page_view", "page": "schedule"}], user_agent=None)
    first = store.report(days=7)["events"]
    second = store.report(days=7)["events"]
    assert first == second == {"page_view": 1.0}


# --------------------------------------------------------------------------- #
# HTTP surface
# --------------------------------------------------------------------------- #

def test_endpoint_accepts_valid_events_and_drops_invalid_ones(tmp_path):
    with _client(tmp_path) as client:
        response = client.post("/api/v1/analytics/events", json={"events": [
            {"event": "page_view", "session_id": "tmp_abc123", "data": {"page": "recommendation"}},
            {"event": "recommendation_impression", "interaction_id": "rec_abc123",
             "data": {"course_id": "1", "position": 1, "method": "semantic"}},
            {"event": "recommendation_impression", "interaction_id": "rec_abc123",
             "data": {"course_id": "ghost", "position": 1, "method": "semantic"}},
            {"event": "definitely_not_an_event", "data": {}},
        ]})
        assert response.status_code == 202
        assert response.json() == {"accepted": 2, "rejected": 2}


def test_endpoint_refuses_forbidden_properties_and_oversized_batches(tmp_path):
    with _client(tmp_path) as client:
        forbidden = client.post("/api/v1/analytics/events", json={
            "events": [{"event": "page_view", "data": {"page": "schedule"}}],
            "user_id": "student-405123456",
        })
        assert forbidden.status_code == 400

        oversized = client.post("/api/v1/analytics/events", json={
            "events": [{"event": "page_view", "data": {"page": "schedule"}}] * 100,
        })
        assert oversized.status_code == 413


def test_endpoint_rejects_a_body_over_the_global_size_limit(tmp_path):
    with _client(tmp_path) as client:
        # `enforce_request_size` caps every POST at 16 KiB before routing.
        response = client.post(
            "/api/v1/analytics/events",
            content=b'{"events":[' + b'{"event":"page_view","data":{"page":"schedule"}},' * 900 + b']}',
            headers={"content-type": "application/json"},
        )
        assert response.status_code == 413


def test_report_requires_a_configured_token(tmp_path, monkeypatch):
    monkeypatch.delenv("FJU_ANALYTICS_ADMIN_TOKEN", raising=False)
    with _client(tmp_path) as client:
        assert client.get("/api/v1/analytics/report").status_code == 503


def test_report_requires_the_right_token(tmp_path, monkeypatch):
    with _client(tmp_path, token="s3cret", monkeypatch=monkeypatch) as client:
        assert client.get("/api/v1/analytics/report").status_code == 401
        assert client.get(
            "/api/v1/analytics/report", headers={"X-Analytics-Token": "wrong"}
        ).status_code == 401
        ok = client.get("/api/v1/analytics/report", headers={"X-Analytics-Token": "s3cret"})
        assert ok.status_code == 200
        assert ok.json()["retention"]["raw_search_query"] == "never stored"


def test_report_token_attempts_are_rate_limited_before_report_generation(tmp_path, monkeypatch):
    monkeypatch.setenv("FJU_ANALYTICS_ADMIN_REQUESTS_PER_MINUTE", "2")
    with _client(tmp_path, token="s3cret", monkeypatch=monkeypatch) as client:
        assert client.get("/api/v1/analytics/report", headers={"X-Analytics-Token": "wrong"}).status_code == 401
        assert client.get("/api/v1/analytics/report", headers={"X-Analytics-Token": "wrong"}).status_code == 401
        assert client.get("/api/v1/analytics/report", headers={"X-Analytics-Token": "s3cret"}).status_code == 429


def test_dashboard_page_carries_no_data(tmp_path):
    with _client(tmp_path) as client:
        page = client.get("/api/v1/analytics/dashboard")
        assert page.status_code == 200
        assert "X-Analytics-Token" in page.text
        assert "noindex" in page.text


def test_dashboard_does_not_invite_browser_password_autofill(tmp_path):
    """Chrome ignores `autocomplete="off"` on a password field.

    It autofilled a saved site password into the token box, and the page's
    auto-submit then sent it on every load — a wall of 401s with nobody typing.
    """
    with _client(tmp_path) as client:
        page = client.get("/api/v1/analytics/dashboard").text
    # Scoped to the tag itself: the comment above it names the old value, and a
    # whole-page substring check would match that instead.
    tag = re.search(r'<input id="token"[^>]*>', page, re.S)
    assert tag is not None
    assert 'autocomplete="new-password"' in tag.group(0)
    assert 'autocomplete="off"' not in tag.group(0)


def test_analytics_outage_does_not_break_the_product(tmp_path):
    output = tmp_path / "artifacts"
    build_artifacts([_record("1", "資料科學")], output, encoder=FakeEncoder(), year=115, semester=1)
    app = create_app(
        store=ArtifactStore(output),
        query_encoder=FakeQueryEncoder(),
        analytics_store=None,
        load_runtime=False,
    )
    with TestClient(app) as client:
        # Search, recommendation sources and the catalog all keep working with
        # analytics storage entirely absent...
        assert client.get("/api/v1/courses?q=資料").json()["total"] == 1
        assert client.post("/api/v1/query-embedding", json={"text": "資料分析"}).status_code == 200
        # ...and the ingest endpoint still answers, so a client flush cannot
        # surface an error to the user.
        posted = client.post("/api/v1/analytics/events", json={
            "events": [{"event": "page_view", "data": {"page": "recommendation"}}]
        })
        assert posted.status_code == 202
        assert posted.json() == {"accepted": 0, "rejected": 0}


def test_interaction_linkage_works_within_a_flow_but_not_across_sessions(tmp_path):
    store = _store(tmp_path)
    store.record(
        [
            {"event": "recommendation_impression", "session_id": "tmp_sessaaa",
             "interaction_id": "rec_flow1", "course_id": "C1", "position": 1, "method": "semantic"},
            {"event": "recommendation_clicked", "session_id": "tmp_sessaaa",
             "interaction_id": "rec_flow1", "course_id": "C1", "position": 1},
            {"event": "course_added", "session_id": "tmp_sessaaa",
             "interaction_id": "rec_flow1", "course_id": "C1", "source": "recommendation"},
            # A different browser session: no shared identifier of any kind.
            {"event": "course_added", "session_id": "tmp_sessbbb",
             "interaction_id": "rec_flow2", "course_id": "C2", "source": "recommendation"},
        ],
        user_agent=None,
    )
    with store._connect() as connection:  # noqa: SLF001
        funnel = connection.execute(
            "SELECT event FROM analytics_events WHERE interaction_id = 'rec_flow1' ORDER BY id"
        ).fetchall()
        # Nothing in the schema can join the two sessions into one student.
        columns = {row[1] for row in connection.execute("PRAGMA table_info(analytics_events)")}
    assert [row[0] for row in funnel] == [
        "recommendation_impression",
        "recommendation_clicked",
        "course_added",
    ]
    assert not columns & {"user_id", "device_id", "persistent_id", "uuid", "ip"}


def test_a_student_schedule_cannot_be_reconstructed_after_identifier_retention(tmp_path):
    """The structural promise of §14: no long-lived key joins course rows.

    Within the 7-day window a session's adds are linkable — that is what makes
    funnel analysis possible at all. After it, `maintain` nulls the identifiers,
    so every remaining row is a bare (day, course, event) triple.
    """
    store = _store(tmp_path, events_days=180, diagnostics_days=90, identifier_days=7)
    store.record(
        [
            {"event": "course_added", "session_id": "tmp_sessaaa", "course_id": course, "source": "search"}
            for course in ("C1", "C2", "C3")
        ],
        user_agent=None,
    )
    old = (datetime.now(timezone.utc) - timedelta(days=8)).date().isoformat()
    with store._connect() as connection:  # noqa: SLF001
        connection.execute("UPDATE analytics_events SET day = ?", (old,))
        connection.commit()

    store.maintain(force=True)

    with store._connect() as connection:  # noqa: SLF001
        rows = connection.execute(
            "SELECT session_id, interaction_id, course_id FROM analytics_events ORDER BY course_id"
        ).fetchall()
    assert rows == [(None, None, "C1"), (None, None, "C2"), (None, None, "C3")]
