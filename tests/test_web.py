from __future__ import annotations

import builtins
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient
from starlette.requests import Request

from fju_outline.artifacts import build_artifacts
from fju_outline.web import ArtifactStore, RateLimiter, create_app, get_rate_limit_client_key

from test_artifacts import FakeEncoder, _record


class FakeQueryEncoder:
    model_name = "fake/test-model"
    model_revision = "test-revision"

    def encode(self, text: str) -> np.ndarray:
        return np.array([1.0, 0.0, 0.0], dtype=np.float32)

    def encode_many(self, texts: list[str]) -> np.ndarray:
        return np.stack([self.encode(text) for text in texts])


def _client(tmp_path: Path) -> TestClient:
    output = tmp_path / "artifacts"
    build_artifacts([_record("1", "資料科學")], output, encoder=FakeEncoder(), year=115, semester=1)
    app = create_app(store=ArtifactStore(output), query_encoder=FakeQueryEncoder(), load_runtime=False)
    return TestClient(app)


def _request(peer: str, headers: dict[str, str] | None = None) -> Request:
    return Request({
        "type": "http",
        "method": "GET",
        "path": "/",
        "query_string": b"",
        "headers": [(key.lower().encode(), value.encode()) for key, value in (headers or {}).items()],
        "client": (peer, 12345),
        "server": ("testserver", 80),
        "scheme": "http",
    })


def test_rate_limit_key_uses_trusted_cloudflare_client_ip(monkeypatch):
    monkeypatch.setenv("FJU_ENV", "production")
    monkeypatch.setenv("FJU_TRUSTED_PROXY_IPS", "172.24.0.1/32")
    first = get_rate_limit_client_key(_request("172.24.0.1", {"CF-Connecting-IP": "203.0.113.10"}))
    second = get_rate_limit_client_key(_request("172.24.0.1", {"CF-Connecting-IP": "203.0.113.11"}))
    assert first != second
    assert first == get_rate_limit_client_key(_request("172.24.0.1", {"CF-Connecting-IP": "203.0.113.10"}))
    limiter = RateLimiter(requests=1)
    assert limiter.allow(first)
    assert limiter.allow(second)
    assert not limiter.allow(first)


def test_development_missing_trusted_proxy_uses_local_peers(monkeypatch):
    monkeypatch.setenv("FJU_ENV", "development")
    monkeypatch.delenv("FJU_TRUSTED_PROXY_IPS", raising=False)
    assert get_rate_limit_client_key(
        _request("127.0.0.1", {"CF-Connecting-IP": "203.0.113.10"})
    ) == "cf:203.0.113.10"


def test_production_missing_trusted_proxy_fails_closed(monkeypatch):
    monkeypatch.setenv("FJU_ENV", "production")
    monkeypatch.delenv("FJU_TRUSTED_PROXY_IPS", raising=False)
    assert get_rate_limit_client_key(
        _request("172.23.0.1", {"CF-Connecting-IP": "203.0.113.10"})
    ) == "peer:172.23.0.1"


def test_production_proxy_allowlist_rejects_broad_default_and_invalid_entries(monkeypatch):
    monkeypatch.setenv("FJU_ENV", "production")
    monkeypatch.delenv("FJU_TRUSTED_PROXY_IPS", raising=False)
    assert get_rate_limit_client_key(
        _request("172.16.12.4", {"CF-Connecting-IP": "203.0.113.10"})
    ) == "peer:172.16.12.4"

    monkeypatch.setenv("FJU_TRUSTED_PROXY_IPS", "172.24.0.1/32,not-an-ip")
    assert get_rate_limit_client_key(
        _request("172.24.0.1", {"CF-Connecting-IP": "203.0.113.10"})
    ) == "peer:172.24.0.1"


def test_rate_limit_key_rejects_spoofed_or_missing_proxy_headers(monkeypatch):
    monkeypatch.setenv("FJU_ENV", "production")
    monkeypatch.setenv("FJU_TRUSTED_PROXY_IPS", "172.24.0.1/32")
    spoofed = get_rate_limit_client_key(
        _request("198.51.100.9", {"CF-Connecting-IP": "203.0.113.99", "X-Forwarded-For": "203.0.113.99"})
    )
    unchanged = get_rate_limit_client_key(_request("198.51.100.9", {"CF-Connecting-IP": "198.0.2.1"}))
    fallback = get_rate_limit_client_key(_request("198.51.100.9"))
    assert spoofed == unchanged == fallback == "peer:198.51.100.9"


def test_health_catalog_and_embedding_api(tmp_path):
    with _client(tmp_path) as client:
        assert client.get("/health/ready").status_code == 200
        assert client.get("/api/v1/catalog/manifest").json()["course_count"] == 1
        departments = client.get("/api/v1/departments")
        assert departments.status_code == 200
        assert departments.json()["schema_version"].startswith("fju_department_catalog_")
        assert client.get("/api/v1/courses?q=資料").json()["total"] == 1
        assert client.get("/api/v1/class-groups?division=日間部&grade=3").json()["items"] == ["甲班"]
        response = client.post("/api/v1/query-embedding", json={"text": "我想學資料分析"})
        assert response.status_code == 200
        assert response.json()["dimension"] == 3


def test_production_hardening_headers_are_present_and_api_docs_are_hidden(tmp_path, monkeypatch):
    monkeypatch.delenv("FJU_ENV", raising=False)
    monkeypatch.delenv("FJU_ENABLE_API_DOCS", raising=False)
    with _client(tmp_path) as client:
        response = client.get("/health/live")
        assert response.status_code == 200
        assert response.headers["X-Content-Type-Options"] == "nosniff"
        assert response.headers["X-Frame-Options"] == "DENY"
        assert response.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"
        assert "camera=()" in response.headers["Permissions-Policy"]
        assert "frame-ancestors 'none'" in response.headers["Content-Security-Policy"]
        for path in ("/docs", "/redoc", "/openapi.json"):
            assert client.get(path).status_code == 404


def test_development_can_keep_api_docs_enabled(tmp_path, monkeypatch):
    monkeypatch.setenv("FJU_ENV", "development")
    monkeypatch.delenv("FJU_ENABLE_API_DOCS", raising=False)
    with _client(tmp_path) as client:
        assert client.get("/docs").status_code == 200
        assert client.get("/redoc").status_code == 200
        assert client.get("/openapi.json").status_code == 200


def test_batch_and_lookup_course_api(tmp_path):
    with _client(tmp_path) as client:
        batch = client.post("/api/v1/courses/batch", json={"course_ids": ["1", "missing"]})
        assert batch.status_code == 200
        assert [item["course_id"] for item in batch.json()["items"]] == ["1"]
        assert batch.json()["missing_course_ids"] == ["missing"]

        lookup = client.post("/api/v1/courses/lookup", json={"values": ["資料科學", "不存在"]})
        assert lookup.status_code == 200
        assert [item["course_id"] for item in lookup.json()["items"]] == ["1"]
        assert lookup.json()["matched_values"] == ["資料科學"]
        assert lookup.json()["unmatched_values"] == ["不存在"]

        assert client.post("/api/v1/courses/batch", json={"course_ids": []}).status_code == 422
        assert client.post("/api/v1/courses/lookup", json={"values": []}).status_code == 422


def test_large_json_responses_are_compressed(tmp_path):
    records = [_record(str(index), f"資料科學 {index}") for index in range(20)]
    output = tmp_path / "artifacts"
    build_artifacts(records, output, encoder=FakeEncoder(), year=115, semester=1)
    app = create_app(store=ArtifactStore(output), query_encoder=FakeQueryEncoder(), load_runtime=False)
    with TestClient(app) as client:
        response = client.get("/api/v1/courses?page_size=20", headers={"Accept-Encoding": "gzip"})
        assert response.status_code == 200
        assert response.headers["content-encoding"] == "gzip"


def test_embedding_api_rejects_profile_fields_and_blank_text(tmp_path):
    with _client(tmp_path) as client:
        assert client.post("/api/v1/query-embedding", json={"text": " "}).status_code == 422
        response = client.post(
            "/api/v1/query-embedding",
            json={"text": "人工智慧", "completedCourses": ["1"]},
        )
        assert response.status_code == 422


def test_ai_endpoint_is_disabled_without_api_key(tmp_path, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    import fju_outline.web as web_module

    original_import = builtins.__import__

    def reject_openai_import(name, *args, **kwargs):
        if name == "openai":
            raise AssertionError("OpenAI provider must not be imported without an API key")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", reject_openai_import)
    assert web_module._build_rag_service([]) is None
    with _client(tmp_path) as client:
        response = client.post(
            "/api/v1/ai/ask",
            json={"question": "推薦資料科學課", "context": {}, "hard_constraints": {}},
        )
        assert response.status_code == 503


def test_missing_api_key_blocks_even_an_injected_rag_service(tmp_path, monkeypatch):
    class ProviderSpy:
        calls = 0

        def ask(self, payload):
            self.calls += 1
            return {"answer": "unexpected", "recommendations": []}

    monkeypatch.setenv("OPENAI_API_KEY", "")
    output = tmp_path / "artifacts"
    build_artifacts([_record("1", "資料科學")], output, encoder=FakeEncoder(), year=115, semester=1)
    spy = ProviderSpy()
    app = create_app(
        store=ArtifactStore(output),
        query_encoder=FakeQueryEncoder(),
        rag_service=spy,
        load_runtime=False,
    )
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/ai/ask",
            json={"question": "推薦資料科學課", "context": {}, "hard_constraints": {}},
        )
        assert response.status_code == 503
        assert spy.calls == 0
        assert client.get("/api/v1/features").json()["ai_assistant_enabled"] is False


def test_ai_request_body_limit_is_preserved(tmp_path):
    with _client(tmp_path) as client:
        response = client.post(
            "/api/v1/ai/ask",
            content=b"{" + b"x" * (16 * 1024) + b"}",
            headers={"content-type": "application/json"},
        )
        assert response.status_code == 413
        assert response.headers["X-Content-Type-Options"] == "nosniff"


def test_batch_embedding_features_and_route_artifacts(tmp_path, monkeypatch):
    monkeypatch.setenv("FJU_COMPOUND_QUERY_ENABLED", "0")
    with _client(tmp_path) as client:
        response = client.post("/api/v1/query-embeddings", json={"texts": ["資料庫", "後端"]})
        assert response.status_code == 200
        assert len(response.json()["vectors"]) == 2
        assert client.post("/api/v1/query-embeddings", json={"texts": []}).status_code == 422
        assert client.post("/api/v1/query-embeddings", json={"texts": [" "]}).status_code == 422
        assert client.post("/api/v1/query-embeddings", json={"texts": ["x"] * 9}).status_code == 422
        assert client.post("/api/v1/query-embeddings", json={"texts": ["x" * 501]}).status_code == 422
        assert client.post("/api/v1/query-embeddings", json={"texts": ["資料庫"], "profile": {}}).status_code == 422
        assert client.get("/api/v1/features").json() == {
            "compound_query_enabled": False,
            "query_analysis_version": "deterministic-v1",
            "analytics_enabled": False,
            "ai_assistant_enabled": False,
            "ai_model": "gpt-5.6-luna",
            "ai_max_question_chars": 500,
        }
        assert client.get("/api/v1/query-routes/index").status_code == 200
        assert client.get("/api/v1/query-routes/data").status_code == 200
        monkeypatch.setenv("FJU_COMPOUND_QUERY_ENABLED", "1")
        assert client.get("/api/v1/features").json()["compound_query_enabled"] is True


def test_department_facets_use_official_identity(tmp_path):
    first = _record("1", "企業管理課程")
    first["organization"].update(
        {
            "division_code": "D",
            "department_name_zh": "企管",
            "official_department_code": "0E",
            "official_department_name_zh": "企業管理學系",
            "official_department_label": "0E-企業管理學系",
            "official_department_type": "department",
        }
    )
    second = _record("2", "企業管理學程課程")
    second["organization"].update(
        {
            "division_code": "D",
            "department_name_zh": "企管",
            "official_department_code": "K14",
            "official_department_name_zh": "國際企業管理學程",
            "official_department_label": "K14-國際企業管理學程",
            "official_department_type": "program",
        }
    )
    output = tmp_path / "artifacts"
    build_artifacts([first, second], output, encoder=FakeEncoder(), year=115, semester=1)
    store = ArtifactStore(output)
    options = store.facets()["departments"]
    assert {item["value"] for item in options} == {"D:0E:department", "D:K14:program"}
    assert {item["label"] for item in options} == {"0E-企業管理學系", "K14-國際企業管理學程"}
    assert store.list_courses(department="D:0E:department")["total"] == 1
    assert store.list_courses(department="企管")["total"] == 0


def test_course_tag_facets_and_filtering(tmp_path):
    first = _record("1", "全英專業課")
    first["course_tags"] = [{
        "code": "302",
        "label_zh": "全英-專業學科類",
        "display_order": 2,
    }]
    second = _record("2", "程式設計課")
    second["course_tags"] = [{
        "code": "100",
        "label_zh": "程式設計類",
        "display_order": 4,
    }]
    output = tmp_path / "artifacts"
    build_artifacts([first, second], output, encoder=FakeEncoder(), year=115, semester=1)
    store = ArtifactStore(output)

    assert store.facets()["course_tags"] == [
        {"value": "302", "label": "全英-專業學科類"},
        {"value": "100", "label": "程式設計類"},
    ]
    assert store.list_courses(course_tag=["302"])["total"] == 1

    app = create_app(store=store, query_encoder=FakeQueryEncoder(), load_runtime=False)
    with TestClient(app) as client:
        response = client.get("/api/v1/courses?course_tag=302&course_tag=100")
        assert response.status_code == 200
        assert response.json()["total"] == 2
