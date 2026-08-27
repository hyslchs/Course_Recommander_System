from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from scripts.verify_artifact_bundle import (
    DOCUMENT_PROMPT,
    DOCUMENT_PROMPT_VERSION,
    MODEL_ID,
    MODEL_REVISION,
    QUERY_PROMPT,
    QUERY_PROMPT_VERSION,
    verify_bundle,
)


ROUTE_IDS = ["capstone", "internship", "hands_on", "beginner", "career_goal", "research"]


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _make_bundle(tmp_path: Path) -> tuple[Path, Path, Path]:
    root = tmp_path / "bundle"
    vector = root / "vector"
    canonical = root / "canonical" / "course_outlines_1151.jsonl"
    vector.mkdir(parents=True)
    canonical.parent.mkdir()
    rows = [
        {"course": {"course_id": "c1"}},
        {"course": {"course_id": "c2"}},
    ]
    canonical.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    (vector / "catalog.json").write_text(json.dumps({"courses": [{"course_id": "c1"}, {"course_id": "c2"}]}), encoding="utf-8")
    (vector / "embedding-index.json").write_text(json.dumps({"count": 2, "dimension": 768, "rows": [{"course_id": "c1"}, {"course_id": "c2"}]}), encoding="utf-8")
    (vector / "course-embeddings.f32").write_bytes(b"\0" * (2 * 768 * 4))
    (vector / "query-route-index.json").write_text(json.dumps({"count": 6, "dimension": 768, "routes": [{"route_id": value} for value in ROUTE_IDS]}), encoding="utf-8")
    (vector / "query-route-embeddings.f32").write_bytes(b"\0" * (6 * 768 * 4))

    bundle_id = "test-bundle"
    canonical_meta = {"path": "canonical/course_outlines_1151.jsonl", "sha256": _sha256(canonical), "bytes": canonical.stat().st_size, "record_count": 2}
    files = {name: {"sha256": _sha256(vector / name), "bytes": (vector / name).stat().st_size} for name in ("catalog.json", "course-embeddings.f32", "embedding-index.json", "query-route-embeddings.f32", "query-route-index.json")}
    manifest = {
        "bundle_id": bundle_id,
        "artifact_schema_version": "fju_embedding_artifact_v1",
        "model_id": MODEL_ID,
        "model_revision": MODEL_REVISION,
        "tokenizer_revision": MODEL_REVISION,
        "provider": "sentence-transformers",
        "dtype": "float32",
        "dimension": 768,
        "course_count": 2,
        "document_prompt_template": DOCUMENT_PROMPT,
        "document_prompt_version": DOCUMENT_PROMPT_VERSION,
        "query_prompt_template": QUERY_PROMPT,
        "query_prompt_version": QUERY_PROMPT_VERSION,
        "query_route_count": 6,
        "input_snapshot": {"canonical_jsonl": canonical_meta},
        "provenance": {"canonical_sha256": canonical_meta["sha256"]},
        "files": files,
    }
    manifest_path = vector / "artifact-manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    lock = {
        "lock_schema_version": "crs_artifact_lock_v1",
        "bundle_id": bundle_id,
        "canonical": canonical_meta,
        "artifact": {"path": "vector", "manifest_sha256": _sha256(manifest_path), "files": files},
        "embedding": {
            "model_id": MODEL_ID,
            "model_revision": MODEL_REVISION,
            "tokenizer_revision": MODEL_REVISION,
            "dimension": 768,
            "dtype": "float32",
            "document_prompt_template": DOCUMENT_PROMPT,
            "document_prompt_version": DOCUMENT_PROMPT_VERSION,
            "query_prompt_template": QUERY_PROMPT,
            "query_prompt_version": QUERY_PROMPT_VERSION,
            "route_ids": ROUTE_IDS,
        },
    }
    lock_path = root / "bundle-lock.json"
    lock_path.write_text(json.dumps(lock), encoding="utf-8")
    return vector, canonical, lock_path


def test_verifier_accepts_complete_bundle(tmp_path):
    vector, canonical, lock = _make_bundle(tmp_path)
    result = verify_bundle(artifact_dir=vector, canonical=canonical, lock=lock)
    assert result["status"] == "verified"
    assert result["course_count"] == 2
    assert result["route_count"] == 6


def test_verifier_rejects_canonical_provenance_change(tmp_path):
    vector, canonical, lock = _make_bundle(tmp_path)
    canonical.write_text(canonical.read_text(encoding="utf-8") + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match="canonical sha256 mismatch"):
        verify_bundle(artifact_dir=vector, canonical=canonical, lock=lock)
