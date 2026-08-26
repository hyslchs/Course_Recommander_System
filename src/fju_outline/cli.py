from __future__ import annotations

import argparse
import asyncio
from pathlib import Path
from typing import Any

from .client import FjuOutlineClient
from .config import (
    DEFAULT_CONCURRENCY,
    DEFAULT_HT,
    DEFAULT_HY,
    DEFAULT_LCID,
    DEFAULT_PAGE_SIZE,
    DEFAULT_SCO_TYP,
    DatasetPaths,
)
from .crawler import crawl_all, discover
from .departments import fetch_official_department_catalog
from .artifacts import (
    DEFAULT_MODEL,
    SentenceTransformerEncoder,
    add_route_artifacts,
    build_artifacts,
    refresh_catalog_artifact,
)
from .io import iter_jsonl, write_json, write_jsonl
from .normalize import normalize_course_record


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "discover":
        _run_discover(args)
    elif args.command == "departments":
        _run_departments(args)
    elif args.command == "crawl":
        _run_crawl(args)
    elif args.command == "normalize":
        _run_normalize(args)
    elif args.command == "export":
        _run_export(args)
    elif args.command == "validate":
        _run_validate(args)
    elif args.command == "artifacts":
        _run_artifacts(args)
    elif args.command == "routes":
        _run_routes(args)
    elif args.command == "refresh-catalog":
        _run_refresh_catalog(args)
    elif args.command == "evaluation-draft":
        from .compound_evaluation import write_draft

        write_draft(Path(args.output))
        print(_summary({"rows": 160, "output": args.output, "status": "draft"}))
    else:
        parser.print_help()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="fju-outline")
    parser.add_argument("--base-dir", default=".", help="Repository/data root.")
    parser.add_argument(
        "--transport",
        choices=["auto", "scrapling", "httpx", "urllib"],
        default="auto",
        help="HTTP transport. auto prefers Scrapling, then httpx, then urllib.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in (
        "discover", "departments", "crawl", "normalize", "export", "validate",
        "artifacts", "routes", "refresh-catalog",
    ):
        sub = subparsers.add_parser(name)
        _add_dataset_args(sub)
    crawl = subparsers.choices["crawl"]
    crawl.add_argument("--page-size", type=int, default=DEFAULT_PAGE_SIZE)
    crawl.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY)
    crawl.add_argument("--limit", type=int, default=None, help="Limit courses for smoke tests.")
    artifacts = subparsers.choices["artifacts"]
    artifacts.add_argument("--model", default=DEFAULT_MODEL)
    artifacts.add_argument("--batch-size", type=int, default=64)
    draft = subparsers.add_parser("evaluation-draft")
    draft.add_argument("--output", default="evaluation/compound_queries_v1.json")
    return parser


def _add_dataset_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--hy", type=int, default=DEFAULT_HY)
    parser.add_argument("--ht", type=int, default=DEFAULT_HT)
    parser.add_argument("--sco-typ", type=int, default=DEFAULT_SCO_TYP)
    parser.add_argument("--lcid", type=int, default=DEFAULT_LCID)


def _client(args: argparse.Namespace) -> FjuOutlineClient:
    return FjuOutlineClient(transport=args.transport)


def _paths(args: argparse.Namespace) -> DatasetPaths:
    return DatasetPaths(base_dir=Path(args.base_dir), hy=args.hy, ht=args.ht)


def _run_discover(args: argparse.Namespace) -> None:
    result = asyncio.run(
        discover(
            _client(args),
            hy=args.hy,
            ht=args.ht,
            sco_typ=args.sco_typ,
            lcid=args.lcid,
        )
    )
    print(_summary(result))


def _run_departments(args: argparse.Namespace) -> None:
    paths = _paths(args)
    result = asyncio.run(
        fetch_official_department_catalog(
            _client(args),
            hy=args.hy,
            lcid=args.lcid,
        )
    )
    write_json(paths.department_catalog_json, result)
    print(_summary({
        "departments": len(result.get("departments") or []),
        "divisions": len(result.get("divisions") or []),
        "output": str(paths.department_catalog_json),
    }))


def _run_crawl(args: argparse.Namespace) -> None:
    result = asyncio.run(
        crawl_all(
            _client(args),
            paths=_paths(args),
            hy=args.hy,
            ht=args.ht,
            page_size=args.page_size,
            concurrency=args.concurrency,
            sco_typ=args.sco_typ,
            lcid=args.lcid,
            limit=args.limit,
        )
    )
    print(_summary(result))


def _run_normalize(args: argparse.Namespace) -> None:
    paths = _paths(args)
    department_catalog = None
    if paths.department_catalog_json.exists():
        import orjson

        department_catalog = orjson.loads(paths.department_catalog_json.read_bytes())
    records = (
        normalize_course_record(row, department_catalog=department_catalog)
        for row in iter_jsonl(paths.raw_jsonl) or []
    )
    count = write_jsonl(paths.canonical_jsonl, records)
    print(_summary({"canonical_records": count, "output": str(paths.canonical_jsonl)}))


def _run_export(args: argparse.Namespace) -> None:
    from .export import export_parquet

    paths = _paths(args)
    records = list(iter_jsonl(paths.canonical_jsonl) or [])
    counts = export_parquet(records, paths.derived_dir)
    print(_summary({"records": len(records), "tables": counts, "output": str(paths.derived_dir)}))


def _run_validate(args: argparse.Namespace) -> None:
    paths = _paths(args)
    raw_records = list(iter_jsonl(paths.raw_jsonl) or [])
    canonical_records = list(iter_jsonl(paths.canonical_jsonl) or [])
    raw_ids = [row.get("list_row", {}).get("jonCouSn") for row in raw_records]
    canonical_ids = [row.get("source", {}).get("jon_cou_sn") for row in canonical_records]
    report = {
        "raw_records": len(raw_records),
        "canonical_records": len(canonical_records),
        "raw_unique_ids": len(set(raw_ids)),
        "canonical_unique_ids": len(set(canonical_ids)),
        "raw_duplicate_ids": _duplicates(raw_ids),
        "canonical_duplicate_ids": _duplicates(canonical_ids),
        "missing_required_sections": _missing_required_sections(canonical_records),
    }
    write_json(paths.validation_json, report)
    print(_summary({**report, "output": str(paths.validation_json)}))


def _run_artifacts(args: argparse.Namespace) -> None:
    paths = _paths(args)
    encoder = SentenceTransformerEncoder(args.model)
    manifest = build_artifacts(
        iter_jsonl(paths.canonical_jsonl) or [],
        paths.artifacts_dir,
        encoder=encoder,
        year=args.hy,
        semester=args.ht,
        batch_size=args.batch_size,
    )
    print(_summary({"manifest": manifest, "output": str(paths.artifacts_dir)}))


def _run_routes(args: argparse.Namespace) -> None:
    paths = _paths(args)
    manifest_path = paths.artifacts_dir / "artifact-manifest.json"
    import json

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    encoder = SentenceTransformerEncoder(manifest.get("model_name") or DEFAULT_MODEL)
    result = add_route_artifacts(paths.artifacts_dir, encoder=encoder)
    print(_summary({"manifest": result, "output": str(paths.artifacts_dir)}))


def _run_refresh_catalog(args: argparse.Namespace) -> None:
    paths = _paths(args)
    result = refresh_catalog_artifact(
        iter_jsonl(paths.canonical_jsonl) or [], paths.artifacts_dir
    )
    print(_summary({"manifest": result, "output": str(paths.artifacts_dir)}))


def _duplicates(values: list[Any]) -> list[Any]:
    seen = set()
    duplicates = set()
    for value in values:
        if value in seen:
            duplicates.add(value)
        seen.add(value)
    return sorted(value for value in duplicates if value is not None)


def _missing_required_sections(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    required = ("source", "course", "outline", "raw")
    missing = []
    for record in records:
        absent = [key for key in required if key not in record]
        if absent:
            missing.append({
                "jon_cou_sn": record.get("source", {}).get("jon_cou_sn"),
                "missing": absent,
            })
    return missing


def _summary(data: Any) -> str:
    import json

    return json.dumps(data, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
