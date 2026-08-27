#!/usr/bin/env python3
"""Verify a CRS artifact bundle before image build or deployment."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

MODEL_ID = "google/embeddinggemma-300m"
MODEL_REVISION = "57c266a740f537b4dc058e1b0cda161fd15afa75"
DOCUMENT_PROMPT = "title: {title} | text: {text}"
QUERY_PROMPT = "task: search result | query: {query}"
DOCUMENT_PROMPT_VERSION = "embeddinggemma-document-v1"
QUERY_PROMPT_VERSION = "embeddinggemma-query-v1"
REQUIRED_FILES = (
    "catalog.json",
    "course-embeddings.f32",
    "embedding-index.json",
    "query-route-embeddings.f32",
    "query-route-index.json",
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _metadata(entries: Any) -> dict[str, dict[str, Any]]:
    if isinstance(entries, dict):
        return {str(name): value for name, value in entries.items()}
    if isinstance(entries, list):
        return {str(item["filename"]): item for item in entries}
    raise ValueError("artifact manifest files must be an object or list")


def _course_id(row: dict[str, Any]) -> str:
    course = row.get("course") or {}
    value = course.get("course_id") or row.get("course_id")
    if value is None:
        value = (row.get("source") or {}).get("jon_cou_sn")
    if value is None:
        raise ValueError("canonical row has no course_id")
    return str(value)


def _canonical_ids(path: Path) -> tuple[list[str], int]:
    ids: list[str] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid canonical JSONL at line {line_number}") from exc
            ids.append(_course_id(row))
    if len(ids) != len(set(ids)):
        raise ValueError("canonical course IDs are not unique")
    return ids, len(ids)


def _index_ids(index: dict[str, Any]) -> list[str]:
    if isinstance(index.get("course_ids"), list):
        return [str(value) for value in index["course_ids"]]
    rows = index.get("rows")
    if isinstance(rows, list):
        return [str(row.get("course_id")) for row in rows]
    raise ValueError("embedding index has no course IDs")


def _catalog_ids(catalog: Any) -> list[str]:
    courses = catalog if isinstance(catalog, list) else catalog.get("courses")
    if not isinstance(courses, list):
        raise ValueError("catalog has no course list")
    return [str(row.get("course_id")) for row in courses]


def verify_bundle(
    *,
    artifact_dir: Path,
    canonical: Path,
    lock: Path,
    require_app_validator: bool = False,
) -> dict[str, Any]:
    lock_data = json.loads(lock.read_text(encoding="utf-8"))
    manifest_path = artifact_dir / "artifact-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if lock_data.get("bundle_id") != manifest.get("bundle_id"):
        raise ValueError("bundle ID mismatch between lock and artifact manifest")

    canonical_ids, canonical_count = _canonical_ids(canonical)
    canonical_meta = lock_data.get("canonical") or {}
    actual_canonical = {"sha256": sha256(canonical), "bytes": canonical.stat().st_size}
    for key in ("sha256", "bytes"):
        if actual_canonical[key] != canonical_meta.get(key):
            raise ValueError(f"canonical {key} mismatch")
    if canonical_count != int(canonical_meta.get("record_count", -1)):
        raise ValueError("canonical record count mismatch")

    snapshot = (manifest.get("input_snapshot") or {}).get("canonical_jsonl") or {}
    provenance = manifest.get("provenance") or {}
    if snapshot.get("sha256") != actual_canonical["sha256"]:
        raise ValueError("manifest canonical provenance hash mismatch")
    if provenance.get("canonical_sha256") != actual_canonical["sha256"]:
        raise ValueError("manifest provenance canonical hash mismatch")

    expected_manifest = lock_data.get("artifact", {}).get("manifest_sha256")
    if expected_manifest and sha256(manifest_path) != expected_manifest:
        raise ValueError("artifact manifest checksum mismatch")
    manifest_files = _metadata(manifest.get("files"))
    lock_files = lock_data.get("artifact", {}).get("files") or {}
    for name in REQUIRED_FILES:
        path = artifact_dir / name
        if not path.is_file():
            raise FileNotFoundError(path)
        actual = {"sha256": sha256(path), "bytes": path.stat().st_size}
        for source_name, metadata in (("manifest", manifest_files.get(name)), ("lock", lock_files.get(name))):
            if not metadata or actual["sha256"] != metadata.get("sha256") or actual["bytes"] != int(metadata.get("bytes", -1)):
                raise ValueError(f"{source_name} checksum/size mismatch: {name}")

    expected = {
        "artifact_schema_version": "fju_embedding_artifact_v1",
        "model_id": MODEL_ID,
        "model_revision": MODEL_REVISION,
        "tokenizer_revision": MODEL_REVISION,
        "provider": "sentence-transformers",
        "dtype": "float32",
        "dimension": 768,
        "document_prompt_template": DOCUMENT_PROMPT,
        "document_prompt_version": DOCUMENT_PROMPT_VERSION,
        "query_prompt_template": QUERY_PROMPT,
        "query_prompt_version": QUERY_PROMPT_VERSION,
    }
    for key, value in expected.items():
        if manifest.get(key) != value or lock_data.get("embedding", {}).get(key) not in {None, value}:
            raise ValueError(f"embedding compatibility mismatch: {key}")

    index = json.loads((artifact_dir / "embedding-index.json").read_text(encoding="utf-8"))
    catalog = json.loads((artifact_dir / "catalog.json").read_text(encoding="utf-8"))
    index_ids = _index_ids(index)
    catalog_ids = _catalog_ids(catalog)
    if index_ids != catalog_ids or index_ids != canonical_ids:
        raise ValueError("canonical/catalog/index course order mismatch")
    if len(index_ids) != canonical_count or int(manifest.get("course_count", -1)) != canonical_count:
        raise ValueError("course count mismatch")
    if int(index.get("dimension", 768)) != 768:
        raise ValueError("embedding index dimension mismatch")
    if (artifact_dir / "course-embeddings.f32").stat().st_size != canonical_count * 768 * 4:
        raise ValueError("course embedding byte length mismatch")

    route_index = json.loads((artifact_dir / "query-route-index.json").read_text(encoding="utf-8"))
    route_ids = [str(row.get("route_id") or row.get("id") or "") for row in route_index.get("routes", [])]
    expected_route_ids = [str(value) for value in lock_data.get("embedding", {}).get("route_ids", route_ids)]
    if route_ids != expected_route_ids:
        raise ValueError("query route IDs/order mismatch")
    if int(manifest.get("query_route_count", -1)) != len(route_ids):
        raise ValueError("query route count mismatch")
    if (artifact_dir / "query-route-embeddings.f32").stat().st_size != len(route_ids) * 768 * 4:
        raise ValueError("query route embedding byte length mismatch")

    if require_app_validator:
        from fju_outline.artifacts import validate_artifacts

        validate_artifacts(artifact_dir, verify_hashes=True)

    return {
        "status": "verified",
        "bundle_id": lock_data["bundle_id"],
        "canonical_sha256": actual_canonical["sha256"],
        "course_count": canonical_count,
        "dimension": 768,
        "route_count": len(route_ids),
        "model_revision": MODEL_REVISION,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle")
    parser.add_argument("--artifact-dir", type=Path)
    parser.add_argument("--canonical", type=Path)
    parser.add_argument("--lock", type=Path)
    parser.add_argument("--require-app-validator", action="store_true")
    args = parser.parse_args(argv)
    bundle = Path(args.bundle) if args.bundle else None
    artifact_dir = args.artifact_dir or (bundle / "vector" if bundle else None)
    canonical = args.canonical or (bundle / "canonical" / "course_outlines_1151.jsonl" if bundle else None)
    lock = args.lock or (bundle / "bundle-lock.json" if bundle else None)
    if not artifact_dir or not canonical or not lock:
        parser.error("provide --bundle or all of --artifact-dir, --canonical, and --lock")
    try:
        result = verify_bundle(
            artifact_dir=artifact_dir,
            canonical=canonical,
            lock=lock,
            require_app_validator=args.require_app_validator,
        )
    except (FileNotFoundError, ValueError, KeyError, TypeError) as exc:
        print(f"artifact verification failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
