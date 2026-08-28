from __future__ import annotations

import json

import numpy as np

from fju_outline.artifacts import (
    CATALOG_SCHEMA_VERSION,
    build_artifacts,
    deserialize_catalog_summary,
    normalize_catalog_course_schema,
    validate_artifacts,
)


class FakeEncoder:
    model_name = "fake/test-model"
    model_revision = "test-revision"

    def encode_passages(self, texts: list[str]) -> np.ndarray:
        rows = []
        for text in texts:
            value = float((sum(text.encode("utf-8")) % 7) + 1)
            vector = np.array([value, value + 1, value + 2], dtype=np.float32)
            rows.append(vector / np.linalg.norm(vector))
        return np.stack(rows)

    def encode_query(self, text: str) -> np.ndarray:
        return self.encode_passages([text])[0]


def _record(course_id: str, name: str):
    return {
        "source": {"source_url": f"https://example.test/{course_id}"},
        "course": {
            "course_id": course_id,
            "ava_no": f"C{course_id}",
            "name_zh": name,
            "name_en": name,
            "credits": 3,
            "required_elective_name": "選修",
            "year": 115,
            "semester": 1,
        },
        "organization": {"department_name_zh": "資工三甲", "division_name_zh": "日間部"},
        "teachers": [{"is_primary": True, "name_zh": "王老師"}],
        "class_meetings": [{"weekday": 1, "sections": ["D1"], "room": "SF101", "week_pattern": "A"}],
        "outline": {
            "basic_info": {"rejList": [], "avaNote": ""},
            "learning_objectives": {"objective": f"學習{name}", "prerequisite": "無"},
            "weekly_progress": [{"topic": name, "unit": "第一單元"}],
            "materials": [],
            "assessments": [],
            "core_competencies": [],
            "special_issues": [],
            "innovation_features": [],
        },
    }


def test_build_and_validate_versioned_artifacts(tmp_path):
    output = tmp_path / "artifacts"
    manifest = build_artifacts(
        [_record("1", "資料科學"), _record("2", "人工智慧")],
        output,
        encoder=FakeEncoder(),
        year=115,
        semester=1,
        batch_size=1,
    )
    assert manifest["course_count"] == 2
    assert manifest["dimension"] == 3
    assert manifest["artifact_version"] == "fju_recommender_v3"
    assert manifest["catalog_schema_version"] == CATALOG_SCHEMA_VERSION
    assert manifest["route_count"] == 6
    assert (output / "course-embeddings.f32").stat().st_size == 2 * 3 * 4
    assert (output / "query-route-embeddings.f32").stat().st_size == 6 * 3 * 4
    assert validate_artifacts(output)["model_revision"] == "test-revision"
    catalog = json.loads((output / "catalog.json").read_text(encoding="utf-8"))
    assert catalog[0]["meetings"][0]["sections"] == ["D1"]
    assert catalog[0]["audience_department"] == "資工"
    assert catalog[0]["study_level"] == "undergraduate"
    assert catalog[0]["audience_grade"] == 3
    assert catalog[0]["course_tags"] == []
    summary = deserialize_catalog_summary(json.loads((output / "catalog-summary.json").read_text(encoding="utf-8")))
    assert summary["course_count"] == 2
    assert [item["course_id"] for item in summary["courses"]] == ["1", "2"]
    assert "sections" not in summary["courses"][0]
    assert summary["search_index"]["schema_version"].startswith("fju_bm25_index_")


def test_catalog_preserves_official_department_identity():
    record = _record("1", "鞈?蝘飛")
    record["organization"].update(
        {
            "division_code": "D",
            "official_department_code": "K36",
            "official_department_name_zh": "企業財稅管理學分學程",
            "official_department_label": "K36-企業財稅管理學分學程",
            "official_department_type": "credit_program",
        }
    )
    from fju_outline.artifacts import build_catalog_course

    catalog = build_catalog_course(record)
    assert catalog["department_identity"] == "D:K36:credit_program"
    assert catalog["department_display"] == "K36-企業財稅管理學分學程"


def test_legacy_catalog_migration_removes_stale_no_prerequisite_advisory_rule():
    catalog = normalize_catalog_course_schema({
        "raw_department": "資工二",
        "division": "日間部",
        "prerequisite": "無先修課程。",
        "eligibility_rules": [{
            "kind": "advisory_prerequisite",
            "source_field": "outline.learning_objectives.prerequisite",
        }],
    })
    assert catalog["study_level"] == "undergraduate"
    assert catalog["eligibility_rules"] == []


def test_catalog_preserves_official_course_tags():
    record = _record("1", "跨文化溝通")
    record["course_tags"] = [{
        "code": "302",
        "label_zh": "全英-專業學科類",
        "label_en": "English:Disciplinary Subject (EMI)",
        "note_zh": "英-專業",
        "note_en": "EMI",
        "display_order": 2,
    }]

    from fju_outline.artifacts import build_catalog_course

    catalog = build_catalog_course(record)
    assert catalog["course_tags"] == record["course_tags"]
