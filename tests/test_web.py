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
