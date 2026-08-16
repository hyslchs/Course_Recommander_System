from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Protocol

import numpy as np
import orjson

from .eligibility import (
    base_eligibility_status,
    extract_eligibility_rules,
    infer_audience_grade,
    infer_study_level,
    normalize_audience_department,
)


ARTIFACT_VERSION = "fju_recommender_v2"
DEFAULT_MODEL = "intfloat/multilingual-e5-small"
SECTION_WEIGHTS = {
    "objective": 0.45,
    "weekly_progress": 0.30,
    "prerequisite": 0.15,
    "skills": 0.10,
}
GRADE_RE = re.compile(r"^(.+?)([一二三四五六七])([甲乙丙丁戊己庚辛壬癸愛智仁勇忠孝信義和平]*)$")
GRADE_MAP = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7}


class Encoder(Protocol):
    model_name: str
    model_revision: str

    def encode_passages(self, texts: list[str]) -> np.ndarray: ...

    def encode_query(self, text: str) -> np.ndarray: ...


class SentenceTransformerEncoder:
    def __init__(self, model_name: str = DEFAULT_MODEL) -> None:
        from sentence_transformers import SentenceTransformer

        self.model_name = model_name
        self._model = SentenceTransformer(model_name)
        config = getattr(self._model, "_first_module", lambda: None)()
        auto_model = getattr(config, "auto_model", None)
        commit = getattr(getattr(auto_model, "config", None), "_commit_hash", None)
        self.model_revision = commit or "unknown"

    def encode_passages(self, texts: list[str]) -> np.ndarray:
        values = [f"passage: {text}" for text in texts]
        return np.asarray(
            self._model.encode(values, normalize_embeddings=True, show_progress_bar=False),
            dtype=np.float32,
        )

    def encode_query(self, text: str) -> np.ndarray:
        return np.asarray(
            self._model.encode([f"query: {text}"], normalize_embeddings=True)[0],
            dtype=np.float32,
        )


def build_artifacts(
    records: Iterable[dict[str, Any]],
    output_dir: Path,
    *,
    encoder: Encoder,
    year: int,
    semester: int,
    batch_size: int = 64,
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    catalog = [build_catalog_course(record) for record in records]
    if not catalog:
        raise ValueError("Cannot build artifacts from an empty catalog")

    vectors = _encode_catalog(catalog, encoder=encoder, batch_size=batch_size)
    vectors = np.asarray(vectors, dtype="<f4")
    if vectors.ndim != 2 or vectors.shape[0] != len(catalog):
        raise ValueError("Embedding count does not match catalog count")

    catalog_path = output_dir / "catalog.json"
    index_path = output_dir / "embedding-index.json"
    vectors_path = output_dir / "course-embeddings.f32"
    catalog_path.write_bytes(orjson.dumps(catalog))
    index = {
        "artifact_version": ARTIFACT_VERSION,
        "dimension": int(vectors.shape[1]),
        "dtype": "float32-le",
        "course_ids": [item["course_id"] for item in catalog],
    }
    index_path.write_bytes(orjson.dumps(index))
    vectors.tofile(vectors_path)

    manifest = {
        "artifact_version": ARTIFACT_VERSION,
        "academic_year": year,
        "semester": semester,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model_name": encoder.model_name,
        "model_revision": encoder.model_revision,
        "dimension": int(vectors.shape[1]),
        "course_count": len(catalog),
        "section_weights": SECTION_WEIGHTS,
        "files": {
            path.name: {"sha256": _sha256(path), "bytes": path.stat().st_size}
            for path in (catalog_path, index_path, vectors_path)
        },
    }
    manifest_path = output_dir / "artifact-manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def build_catalog_course(record: dict[str, Any]) -> dict[str, Any]:
    course = record.get("course") or {}
    organization = record.get("organization") or {}
    outline = record.get("outline") or {}
    objective = outline.get("learning_objectives") or {}
    teachers = record.get("teachers") or []
    primary = next((item for item in teachers if item.get("is_primary")), teachers[0] if teachers else {})
    base_department, grade, class_group = split_department_grade(
        organization.get("department_name_zh") or ""
    )
    sections = _document_sections(record)
    rules = extract_eligibility_rules(record)
    study_level = infer_study_level(organization)
    audience_grade = infer_audience_grade(organization)
    audience_department = normalize_audience_department(
        organization.get("department_name_zh")
    )
    department_code = _as_optional_text(
        organization.get("official_department_code")
        or organization.get("department_code")
    )
    department_type = _as_optional_text(organization.get("official_department_type"))
    division_code = _as_optional_text(organization.get("division_code"))
    department_identity = _department_identity(
        division_code=division_code,
        department_code=department_code,
        department_type=department_type,
    )
    return {
        "course_id": str(course.get("course_id") or ""),
        "ava_no": course.get("ava_no"),
        "name_zh": course.get("name_zh"),
        "name_en": course.get("name_en"),
        "credits": course.get("credits"),
        "required_elective_name": course.get("required_elective_name"),
        "academic_year": course.get("year"),
        "semester": course.get("semester"),
        "department": base_department,
        "audience_department": audience_department,
        "raw_department": organization.get("department_name_zh"),
        "department_identity": department_identity,
        "department_display": organization.get("official_department_label") or organization.get("department_name_zh") or base_department,
        "division_code": division_code,
        "department_code": department_code,
        "official_department_name_zh": organization.get("official_department_name_zh"),
        "official_department_label": organization.get("official_department_label"),
        "official_department_type": organization.get("official_department_type"),
        "department_match": organization.get("department_match"),
        "study_level": study_level,
        "audience_grade": audience_grade,
        "grade": grade,
        "class_group": class_group,
        "division": organization.get("division_name_zh"),
        "teacher": primary.get("name_zh"),
        "teacher_en": primary.get("name_en"),
        "meetings": [
            {
                "weekday": item.get("weekday"),
                "sections": item.get("sections") or [],
                "room": item.get("room"),
                "week_pattern": item.get("week_pattern"),
            }
            for item in record.get("class_meetings") or []
        ],
        "sections": sections,
        "prerequisite": objective.get("prerequisite") or "",
        "enrollment_note": (outline.get("basic_info") or {}).get("avaNote") or "",
        "eligibility_base_status": base_eligibility_status(rules),
        "eligibility_rules": rules,
        "source_url": (record.get("source") or {}).get("source_url"),
    }


def split_department_grade(value: str) -> tuple[str, int | None, str]:
    match = GRADE_RE.match(value.strip())
    if not match:
        return value.strip(), None, ""
    base, grade_text, class_text = match.groups()
    return base, GRADE_MAP[grade_text], f"{class_text}班" if class_text else ""


def _as_optional_text(value: Any) -> str | None:
    return None if value is None or value == "" else str(value)


def _department_identity(
    *,
    division_code: str | None,
    department_code: str | None,
    department_type: str | None,
) -> str | None:
    if not department_code:
        return None
    return ":".join(
        [division_code or "unknown", department_code.upper(), department_type or "unknown"]
    )


def validate_artifacts(output_dir: Path, *, verify_hashes: bool = True) -> dict[str, Any]:
    manifest_path = output_dir / "artifact-manifest.json"
    if not manifest_path.exists():
        raise FileNotFoundError(manifest_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for name, metadata in manifest.get("files", {}).items():
        path = output_dir / name
        if not path.exists():
            raise FileNotFoundError(path)
        if path.stat().st_size != metadata["bytes"]:
            raise ValueError(f"Artifact size mismatch: {name}")
        if verify_hashes and _sha256(path) != metadata["sha256"]:
            raise ValueError(f"Artifact checksum mismatch: {name}")
    index = json.loads((output_dir / "embedding-index.json").read_text(encoding="utf-8"))
    if len(index["course_ids"]) != manifest["course_count"]:
        raise ValueError("Embedding index count mismatch")
    expected_bytes = manifest["course_count"] * manifest["dimension"] * 4
    if (output_dir / "course-embeddings.f32").stat().st_size != expected_bytes:
        raise ValueError("Embedding binary dimensions do not match manifest")
    return manifest


def _document_sections(record: dict[str, Any]) -> dict[str, str]:
    outline = record.get("outline") or {}
    objectives = outline.get("learning_objectives") or {}
    course = record.get("course") or {}
    title = " ".join(
        value for value in (course.get("name_zh"), course.get("name_en")) if value
    )
    weekly = "\n".join(
        " ".join(str(value or "") for value in (item.get("topic"), item.get("unit"))).strip()
        for item in outline.get("weekly_progress") or []
    )
    skills = "；".join(
        str(item.get("name") or "")
        for key in ("core_competencies", "special_issues", "innovation_features")
        for item in outline.get(key) or []
        if item.get("relation") in {1, 3}
    )
    return {
        "objective": "\n".join(
            value for value in (title, objectives.get("objective") or "") if value
        ),
        "weekly_progress": weekly,
        "prerequisite": objectives.get("prerequisite") or "",
        "skills": "；".join(value for value in (title, skills) if value),
        "materials": "\n".join(
            str(item.get("value") or "") for item in outline.get("materials") or []
        ),
        "assessment": "、".join(
            f"{item.get('name_zh') or ''} {item.get('percent') or ''}%".strip()
            for item in outline.get("assessments") or []
        ),
    }


def _encode_catalog(catalog: list[dict[str, Any]], *, encoder: Encoder, batch_size: int) -> np.ndarray:
    combined: list[np.ndarray] = []
    for start in range(0, len(catalog), batch_size):
        batch = catalog[start : start + batch_size]
        section_vectors: dict[str, np.ndarray] = {}
        for section in SECTION_WEIGHTS:
            texts = [
                item["sections"].get(section) or item.get("name_zh") or item.get("name_en") or "課程"
                for item in batch
            ]
            section_vectors[section] = encoder.encode_passages(texts)
        weighted = sum(SECTION_WEIGHTS[key] * section_vectors[key] for key in SECTION_WEIGHTS)
        norms = np.linalg.norm(weighted, axis=1, keepdims=True)
        combined.append((weighted / np.maximum(norms, 1e-12)).astype(np.float32))
    return np.concatenate(combined, axis=0)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()
