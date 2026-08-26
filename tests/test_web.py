from __future__ import annotations

from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

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


def _client(tmp_path: Path) -> TestClient:
    output = tmp_path / "artifacts"
    build_artifacts([_record("1", "資料科學")], output, encoder=FakeEncoder(), year=115, semester=1)
    app = create_app(store=ArtifactStore(output), query_encoder=FakeQueryEncoder(), load_runtime=False)
    return TestClient(app)


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


def test_ai_endpoint_is_disabled_without_api_key(tmp_path):
    with _client(tmp_path) as client:
        response = client.post(
            "/api/v1/ai/ask",
            json={"question": "推薦資料科學課", "context": {}, "hard_constraints": {}},
        )
        assert response.status_code == 503


def test_ai_request_body_limit_is_preserved(tmp_path):
    with _client(tmp_path) as client:
        response = client.post(
            "/api/v1/ai/ask",
            content=b"{" + b"x" * (16 * 1024) + b"}",
            headers={"content-type": "application/json"},
        )
        assert response.status_code == 413


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
