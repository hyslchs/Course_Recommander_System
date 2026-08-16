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


def _client(tmp_path: Path) -> TestClient:
    output = tmp_path / "artifacts"
    build_artifacts([_record("1", "資料科學")], output, encoder=FakeEncoder(), year=115, semester=1)
    app = create_app(store=ArtifactStore(output), query_encoder=FakeQueryEncoder(), load_runtime=False)
    return TestClient(app)


def test_health_catalog_and_embedding_api(tmp_path):
    with _client(tmp_path) as client:
        assert client.get("/health/ready").status_code == 200
        assert client.get("/api/v1/catalog/manifest").json()["course_count"] == 1
        assert client.get("/api/v1/courses?q=資料").json()["total"] == 1
        response = client.post("/api/v1/query-embedding", json={"text": "我想學資料分析"})
        assert response.status_code == 200
        assert response.json()["dimension"] == 3


def test_embedding_api_rejects_profile_fields_and_blank_text(tmp_path):
    with _client(tmp_path) as client:
        assert client.post("/api/v1/query-embedding", json={"text": " "}).status_code == 422
        response = client.post(
            "/api/v1/query-embedding",
            json={"text": "人工智慧", "completedCourses": ["1"]},
        )
        assert response.status_code == 422


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
