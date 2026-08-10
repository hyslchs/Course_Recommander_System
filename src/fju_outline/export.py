from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pandas as pd

from .normalize import build_document


def export_parquet(records: list[dict[str, Any]], output_dir: Path) -> dict[str, int]:
    output_dir.mkdir(parents=True, exist_ok=True)
    tables = {
        "courses": [],
        "course_documents": [],
        "course_relations": [],
        "weekly_progress": [],
        "teaching_methods": [],
        "assessments": [],
        "materials": [],
    }
    for record in records:
        course = record["course"]
        source = record["source"]
        organization = record.get("organization", {})
        primary_teacher = next(
            (teacher for teacher in record.get("teachers", []) if teacher.get("is_primary")),
            (record.get("teachers") or [{}])[0],
        )
        tables["courses"].append({
            **_prefix("source", source),
            **course,
            **_prefix("organization", organization),
            "primary_teacher_id": primary_teacher.get("teacher_id"),
            "primary_teacher_name_zh": primary_teacher.get("name_zh"),
            "primary_teacher_name_en": primary_teacher.get("name_en"),
        })
        tables["course_documents"].append(build_document(record))

        for relation_group in (
            "literacy",
            "core_competencies",
            "special_issues",
            "sdgs",
            "innovation_features",
        ):
            for row in record["outline"].get(relation_group, []):
                tables["course_relations"].append({
                    "course_id": course.get("course_id"),
                    "relation_group": relation_group,
                    **{key: value for key, value in row.items() if key != "raw"},
                })
        for table_name, outline_key in (
            ("weekly_progress", "weekly_progress"),
            ("teaching_methods", "teaching_methods"),
            ("assessments", "assessments"),
            ("materials", "materials"),
        ):
            for row in record["outline"].get(outline_key, []):
                tables[table_name].append({
                    "course_id": course.get("course_id"),
                    **{key: value for key, value in row.items() if key != "raw"},
                })

    counts = {}
    for table_name, rows in tables.items():
        path = output_dir / f"{table_name}.parquet"
        pd.DataFrame(_parquet_safe_rows(rows)).to_parquet(path, index=False)
        counts[table_name] = len(rows)
    return counts


def _prefix(prefix: str, data: dict[str, Any]) -> dict[str, Any]:
    return {f"{prefix}_{key}": value for key, value in data.items()}


def _parquet_safe_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{key: _parquet_safe_value(value) for key, value in row.items()} for row in rows]


def _parquet_safe_value(value: Any) -> Any:
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return value
