#!/usr/bin/env python3
"""Build a pinned 768-dimensional EmbeddingGemma vector bundle."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import shutil
import tempfile
from pathlib import Path

from fju_outline.artifacts import (
    CATALOG_SCHEMA_VERSION,
    EMBEDDING_GEMMA_DOCUMENT_PROMPT,
    EMBEDDING_GEMMA_DOCUMENT_PROMPT_VERSION,
    EMBEDDING_GEMMA_MODEL,
    EMBEDDING_GEMMA_QUERY_PROMPT,
    EMBEDDING_GEMMA_QUERY_PROMPT_VERSION,
    EMBEDDING_GEMMA_REVISION,
    EmbeddingGemmaEncoder,
    build_artifacts,
)
from fju_outline.io import iter_jsonl


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--canonical", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="Final vector directory; must not exist")
    parser.add_argument("--lock-output", type=Path, required=True)
    parser.add_argument("--bundle-id", required=True)
    parser.add_argument("--year", type=int, default=115)
    parser.add_argument("--semester", type=int, default=1)
    parser.add_argument("--batch-size", type=int, default=16)
    args = parser.parse_args(argv)

    if not args.canonical.is_file():
        raise SystemExit(f"canonical file not found: {args.canonical}")
    if args.output.exists() or args.lock_output.exists():
        raise SystemExit("refusing to overwrite an existing artifact output or lock")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.lock_output.parent.mkdir(parents=True, exist_ok=True)
    records = list(iter_jsonl(args.canonical) or [])
    ids = [str((row.get("course") or {}).get("course_id")) for row in records]
    if not records or any(value == "None" for value in ids) or len(ids) != len(set(ids)):
        raise SystemExit("canonical must contain unique course.course_id values")

    temporary = Path(tempfile.mkdtemp(prefix=f".{args.output.name}.", dir=args.output.parent))
    try:
        encoder = EmbeddingGemmaEncoder(
            EMBEDDING_GEMMA_MODEL,
            model_revision=EMBEDDING_GEMMA_REVISION,
            tokenizer_revision=EMBEDDING_GEMMA_REVISION,
            dimension=768,
            document_prompt_template=EMBEDDING_GEMMA_DOCUMENT_PROMPT,
            query_prompt_template=EMBEDDING_GEMMA_QUERY_PROMPT,
            document_prompt_version=EMBEDDING_GEMMA_DOCUMENT_PROMPT_VERSION,
            query_prompt_version=EMBEDDING_GEMMA_QUERY_PROMPT_VERSION,
            device="cpu",
        )
        build_artifacts(
            records,
            temporary,
            encoder=encoder,
            year=args.year,
            semester=args.semester,
            batch_size=args.batch_size,
        )
        manifest_path = temporary / "artifact-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        route_index = json.loads((temporary / "query-route-index.json").read_text(encoding="utf-8"))
        canonical_sha256 = sha256(args.canonical)
        canonical_meta = {
            "path": "canonical/course_outlines_1151.jsonl",
            "sha256": canonical_sha256,
            "bytes": args.canonical.stat().st_size,
            "record_count": len(records),
        }
        manifest.update({
            "bundle_id": args.bundle_id,
            "artifact_schema_version": "fju_embedding_artifact_v1",
            "encoder": "EmbeddingGemmaEncoder",
            "provider": "sentence-transformers",
            "model_id": EMBEDDING_GEMMA_MODEL,
            "model_name": EMBEDDING_GEMMA_MODEL,
            "model_revision": EMBEDDING_GEMMA_REVISION,
            "tokenizer_revision": EMBEDDING_GEMMA_REVISION,
            "dimension": 768,
            "dtype": "float32",
            "document_prompt_template": EMBEDDING_GEMMA_DOCUMENT_PROMPT,
            "document_prompt_version": EMBEDDING_GEMMA_DOCUMENT_PROMPT_VERSION,
            "query_prompt_template": EMBEDDING_GEMMA_QUERY_PROMPT,
            "query_prompt_version": EMBEDDING_GEMMA_QUERY_PROMPT_VERSION,
            "normalization": "L2 normalization after encoder and weighted section pooling",
            "query_route_count": len(route_index.get("routes", [])),
            "query_routes": route_index.get("routes", []),
            "input_snapshot": {"canonical_jsonl": canonical_meta},
            "provenance": {
                "builder": "scripts/build_embedding_bundle.py",
                "canonical_sha256": canonical_sha256,
                "canonical_record_count": len(records),
                "algorithm": "section-pooling-v1",
            },
        })
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.rename(args.output)

        files = {}
        for path in sorted(args.output.iterdir()):
            if path.name == "artifact-manifest.json":
                continue
            files[path.name] = {"sha256": sha256(path), "bytes": path.stat().st_size}
        lock = {
            "lock_schema_version": "crs_artifact_lock_v1",
            "bundle_id": args.bundle_id,
            "canonical": canonical_meta,
            "artifact": {
                "path": "vector",
                "manifest_sha256": sha256(args.output / "artifact-manifest.json"),
                "files": files,
            },
            "embedding": {
                "model_id": EMBEDDING_GEMMA_MODEL,
                "model_revision": EMBEDDING_GEMMA_REVISION,
                "tokenizer_revision": EMBEDDING_GEMMA_REVISION,
                "dimension": 768,
                "dtype": "float32",
                "document_prompt_template": EMBEDDING_GEMMA_DOCUMENT_PROMPT,
                "document_prompt_version": EMBEDDING_GEMMA_DOCUMENT_PROMPT_VERSION,
                "query_prompt_template": EMBEDDING_GEMMA_QUERY_PROMPT,
                "query_prompt_version": EMBEDDING_GEMMA_QUERY_PROMPT_VERSION,
                "schema_version": CATALOG_SCHEMA_VERSION,
                "route_ids": [str(row.get("route_id") or row.get("id")) for row in route_index.get("routes", [])],
            },
            "provenance": manifest["provenance"],
            "build": {
                "python": "3.11",
                "torch": package_version("torch"),
                "sentence_transformers": package_version("sentence-transformers"),
                "transformers": package_version("transformers"),
                "batch_size": args.batch_size,
            },
        }
        args.lock_output.write_text(json.dumps(lock, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except Exception:
        if temporary.exists():
            shutil.rmtree(temporary)
        if args.output.exists() and not args.lock_output.exists():
            shutil.rmtree(args.output)
        raise
    print(json.dumps({"bundle_id": args.bundle_id, "output": str(args.output), "lock": str(args.lock_output)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
