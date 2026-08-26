from __future__ import annotations

import hashlib
import json
import math
import os
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
    is_no_prerequisite_text,
    infer_study_level,
    normalize_audience_department,
)
from .query_routes import build_route_embeddings, route_data


ARTIFACT_VERSION = "fju_recommender_v3"
CATALOG_SCHEMA_VERSION = "fju_catalog_v4"
CATALOG_SCHEMA_FIELDS = (
    "study_level",
    "audience_grade",
    "course_tags",
    "relations",
    "teaching_methods",
    "assessments",
    "teaching_language",
    "material_language",
    "online_teaching",
    "instructors",
)
DEFAULT_MODEL = "intfloat/multilingual-e5-small"
EMBEDDING_GEMMA_MODEL = "google/embeddinggemma-300m"
EMBEDDING_GEMMA_REVISION = "57c266a740f537b4dc058e1b0cda161fd15afa75"
EMBEDDING_GEMMA_DOCUMENT_PROMPT = "title: {title} | text: {text}"
EMBEDDING_GEMMA_QUERY_PROMPT = "task: search result | query: {query}"
EMBEDDING_GEMMA_FULL_DIMENSION = 768
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

    def encode_many(self, texts: list[str]) -> np.ndarray: ...


class SentenceTransformerEncoder:
    def __init__(
        self,
        model_name: str = DEFAULT_MODEL,
        *,
        revision: str | None = None,
        device: str | None = None,
        require_cuda: bool = False,
    ) -> None:
        from sentence_transformers import SentenceTransformer

        if require_cuda or device == "cuda":
            import torch

            if not torch.cuda.is_available():
                raise RuntimeError("CUDA is required for the configured embedding model")
        self.model_name = model_name
        kwargs: dict[str, Any] = {}
        if revision is not None:
            kwargs["revision"] = revision
        if device is not None:
            kwargs["device"] = device
        self._model = SentenceTransformer(model_name, **kwargs)
        config = getattr(self._model, "_first_module", lambda: None)()
        auto_model = getattr(config, "auto_model", None)
        commit = getattr(getattr(auto_model, "config", None), "_commit_hash", None)
        self.model_revision = commit or revision or "unknown"

    def encode_passages(self, texts: list[str]) -> np.ndarray:
        values = [f"passage: {text}" for text in texts]
        return np.asarray(
            self._model.encode(values, normalize_embeddings=True, show_progress_bar=False),
            dtype=np.float32,
        )

    def encode_query(self, text: str) -> np.ndarray:
        return np.asarray(
            self._model.encode(
                [f"query: {text}"],
                normalize_embeddings=True,
                show_progress_bar=False,
            )[0],
            dtype=np.float32,
        )

    def encode_many(self, texts: list[str]) -> np.ndarray:
        return np.asarray(
            self._model.encode(
                [f"query: {text}" for text in texts],
                normalize_embeddings=True,
                show_progress_bar=False,
            ),
            dtype=np.float32,
        )


class EmbeddingGemmaEncoder:
    """Manifest-driven EmbeddingGemma query/document encoder.

    The live query path always runs the full 768-dimensional model.  A 512
    dimensional artifact is projected only after inference by taking the first
    512 values and L2-normalizing again, matching the incoming artifact's
    ``derived_from`` contract.
    """

    def __init__(
        self,
        model_id: str,
        *,
        model_revision: str,
        tokenizer_revision: str | None,
        dimension: int,
        document_prompt_template: str,
        query_prompt_template: str,
        document_prompt_version: str | None = None,
        query_prompt_version: str | None = None,
    ) -> None:
        if model_id != EMBEDDING_GEMMA_MODEL:
            raise ValueError(f"Unsupported EmbeddingGemma model: {model_id}")
        if dimension not in {512, EMBEDDING_GEMMA_FULL_DIMENSION}:
            raise ValueError("EmbeddingGemma artifact dimension must be 512 or 768")
        if document_prompt_template != EMBEDDING_GEMMA_DOCUMENT_PROMPT:
            raise ValueError("EmbeddingGemma document prompt does not match the artifact")
        if query_prompt_template != EMBEDDING_GEMMA_QUERY_PROMPT:
            raise ValueError("EmbeddingGemma query prompt does not match the artifact")

        import torch
        from sentence_transformers import SentenceTransformer

        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is required for EmbeddingGemma inference")

        self.model_name = model_id
        self.model_id = model_id
        self.model_revision = model_revision
        self.tokenizer_revision = tokenizer_revision or model_revision
        self.dimension = dimension
        self.document_prompt_template = document_prompt_template
        self.query_prompt_template = query_prompt_template
        self.document_prompt_version = document_prompt_version or ""
        self.query_prompt_version = query_prompt_version or ""
        self._model = SentenceTransformer(
            model_id,
            revision=model_revision,
            device="cuda",
        )
        self._model.to(dtype=torch.float32)
        config = getattr(self._model, "_first_module", lambda: None)()
        auto_model = getattr(config, "auto_model", None)
        commit = getattr(getattr(auto_model, "config", None), "_commit_hash", None)
        if commit not in {None, model_revision}:
            raise RuntimeError("Loaded EmbeddingGemma revision does not match the artifact")

    def _encode_prompts(self, prompts: list[str]) -> np.ndarray:
        values = np.asarray(
            self._model.encode(
                prompts,
                normalize_embeddings=True,
                convert_to_numpy=True,
                show_progress_bar=False,
            ),
            dtype=np.float32,
        )
        if values.ndim != 2 or values.shape[1] != EMBEDDING_GEMMA_FULL_DIMENSION:
            raise RuntimeError("EmbeddingGemma produced an unexpected vector dimension")
        values = values[:, : self.dimension]
        norms = np.linalg.norm(values, axis=1, keepdims=True)
        return (values / np.maximum(norms, 1e-12)).astype(np.float32)

    def encode_documents(
        self,
        texts: list[str],
        *,
        titles: list[str] | None = None,
    ) -> np.ndarray:
        titles = titles or ["none"] * len(texts)
        if len(titles) != len(texts):
            raise ValueError("Document titles and texts must have the same length")
        prompts = [
            self.document_prompt_template.format(title=title or "none", text=text)
            for title, text in zip(titles, texts)
        ]
        return self._encode_prompts(prompts)

    def encode_passages(self, texts: list[str]) -> np.ndarray:
        return self.encode_documents(texts)

    def encode_query(self, text: str) -> np.ndarray:
        prompt = self.query_prompt_template.format(query=text)
        return self._encode_prompts([prompt])[0]

    def encode_many(self, texts: list[str]) -> np.ndarray:
        prompts = [self.query_prompt_template.format(query=text) for text in texts]
        return self._encode_prompts(prompts)


def encoder_from_manifest(manifest: dict[str, Any]) -> Encoder:
    """Construct the only query encoder compatible with an artifact manifest."""

    model_id = manifest.get("model_id") or manifest.get("model_name")
    if not model_id:
        raise ValueError("Artifact manifest has no model_id/model_name")
    if manifest.get("encoder") == "EmbeddingGemmaEncoder" or model_id.startswith("google/embeddinggemma-"):
        return EmbeddingGemmaEncoder(
            model_id,
            model_revision=str(manifest["model_revision"]),
            tokenizer_revision=manifest.get("tokenizer_revision"),
            dimension=int(manifest["dimension"]),
            document_prompt_template=str(manifest["document_prompt_template"]),
            query_prompt_template=str(manifest["query_prompt_template"]),
            document_prompt_version=manifest.get("document_prompt_version"),
            query_prompt_version=manifest.get("query_prompt_version"),
        )
    return SentenceTransformerEncoder(
        str(model_id),
        revision=manifest.get("model_revision"),
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
    _compact_repeated_catalog_labels(catalog)
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

    route_vectors = build_route_embeddings(encoder, batch_size=batch_size)
    route_index_path = output_dir / "query-route-index.json"
    route_vectors_path = output_dir / "query-route-embeddings.f32"
    route_index_path.write_bytes(
        orjson.dumps(route_data(route_vectors, model_name=encoder.model_name, model_revision=encoder.model_revision))
    )
    route_vectors.tofile(route_vectors_path)

    manifest = {
        "artifact_version": ARTIFACT_VERSION,
        "catalog_schema_version": CATALOG_SCHEMA_VERSION,
        "academic_year": year,
        "semester": semester,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model_name": encoder.model_name,
        "model_revision": encoder.model_revision,
        "dimension": int(vectors.shape[1]),
        "course_count": len(catalog),
        "section_weights": SECTION_WEIGHTS,
        "analysis_version": "deterministic-v1",
        "route_count": int(route_vectors.shape[0]),
        "files": {
            path.name: {"sha256": _sha256(path), "bytes": path.stat().st_size}
            for path in (catalog_path, index_path, vectors_path, route_index_path, route_vectors_path)
        },
    }
    manifest_path = output_dir / "artifact-manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def normalize_catalog_course_schema(
    course: dict[str, Any], *, recompute_study_level: bool = False
) -> dict[str, Any]:
    """Backfill fields introduced after the first catalog artifact release.

    The catalog is also consumed by clients that may still have a legacy
    artifact on disk.  Keeping this migration deterministic makes the API,
    RAG service, and generated artifacts expose the same schema.
    """

    normalized = dict(course)
    raw_department = normalized.get("raw_department") or normalized.get("department")
    division = normalized.get("division")
    organization = {
        "department_name_zh": raw_department,
        "division_name_zh": division,
    }
    inferred_study_level = infer_study_level(organization)
    if recompute_study_level or (
        inferred_study_level != "unknown" and not normalized.get("study_level")
    ):
        normalized["study_level"] = inferred_study_level
    if normalized.get("audience_grade") is None:
        normalized["audience_grade"] = infer_audience_grade(organization)
    normalized["course_tags"] = _normalize_catalog_course_tags(
        normalized.get("course_tags") or []
    )
    normalized["relations"] = normalized.get("relations") or []
    normalized["teaching_methods"] = normalized.get("teaching_methods") or []
    normalized["assessments"] = normalized.get("assessments") or []
    normalized.setdefault("teaching_language", None)
    normalized.setdefault("material_language", None)
    normalized["online_teaching"] = normalized.get("online_teaching") or {
        "sync": False,
        "async": False,
    }
    normalized["instructors"] = normalized.get("instructors") or _legacy_instructors(
        normalized
    )
    if is_no_prerequisite_text(normalized.get("prerequisite")):
        normalized["eligibility_rules"] = [
            rule
            for rule in normalized.get("eligibility_rules") or []
            if not (
                rule.get("kind") == "advisory_prerequisite"
                and rule.get("source_field") == "outline.learning_objectives.prerequisite"
            )
        ]
    return normalized


def refresh_catalog_artifact(
    records: Iterable[dict[str, Any]], output_dir: Path
) -> dict[str, Any]:
    """Refresh catalog metadata without recomputing any embedding vectors."""

    manifest = validate_artifacts(output_dir)
    index = orjson.loads((output_dir / "embedding-index.json").read_bytes())
    catalog = [build_catalog_course(record) for record in records]
    _compact_repeated_catalog_labels(catalog)
    course_ids = [item["course_id"] for item in catalog]
    if not catalog:
        raise ValueError("Cannot refresh an empty catalog")
    if course_ids != index.get("course_ids"):
        raise ValueError("Canonical course IDs/order do not match embedding index")
    if len(catalog) != int(manifest.get("course_count", 0)):
        raise ValueError("Canonical course count does not match artifact manifest")

    catalog_path = output_dir / "catalog.json"
    manifest_path = output_dir / "artifact-manifest.json"
    catalog_tmp = catalog_path.with_suffix(".json.tmp")
    manifest_tmp = manifest_path.with_suffix(".json.tmp")
    catalog_tmp.write_bytes(orjson.dumps(catalog))
    manifest["catalog_schema_version"] = CATALOG_SCHEMA_VERSION
    manifest["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    manifest.setdefault("files", {})["catalog.json"] = {
        "sha256": _sha256(catalog_tmp),
        "bytes": catalog_tmp.stat().st_size,
    }
    manifest_tmp.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    catalog_tmp.replace(catalog_path)
    manifest_tmp.replace(manifest_path)
    return validate_artifacts(output_dir)


def migrate_catalog_artifact(output_dir: Path) -> dict[str, Any]:
    """Upgrade a catalog-only schema without recomputing embedding vectors."""

    manifest = validate_artifacts(output_dir)
    catalog_path = output_dir / "catalog.json"
    catalog = orjson.loads(catalog_path.read_bytes())
    migrated = [
        normalize_catalog_course_schema(item, recompute_study_level=True)
        for item in catalog
    ]
    if migrated != catalog:
        catalog_path.write_bytes(orjson.dumps(migrated))
    manifest["catalog_schema_version"] = CATALOG_SCHEMA_VERSION
    files = manifest.setdefault("files", {})
    files["catalog.json"] = {
        "sha256": _sha256(catalog_path),
        "bytes": catalog_path.stat().st_size,
    }
    (output_dir / "artifact-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return manifest


def add_route_artifacts(output_dir: Path, *, encoder: Encoder) -> dict[str, Any]:
    """Upgrade an existing catalog without recomputing its course vectors."""
    manifest_path = output_dir / "artifact-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    dimension = int(manifest["dimension"])
    if manifest.get("model_revision") not in {None, encoder.model_revision}:
        raise ValueError("Route encoder revision does not match course artifacts")
    route_vectors = build_route_embeddings(encoder)
    if route_vectors.shape[1] != dimension:
        raise ValueError("Route model dimension does not match course artifacts")
    route_index_path = output_dir / "query-route-index.json"
    route_vectors_path = output_dir / "query-route-embeddings.f32"
    route_index_path.write_bytes(
        orjson.dumps(
            route_data(
                route_vectors,
                model_name=manifest.get("model_name"),
                model_revision=manifest.get("model_revision"),
            )
        )
    )
    route_vectors.tofile(route_vectors_path)
    manifest["artifact_version"] = ARTIFACT_VERSION
    manifest["analysis_version"] = "deterministic-v1"
    manifest["route_count"] = int(route_vectors.shape[0])
    files = manifest.setdefault("files", {})
    for path in (route_index_path, route_vectors_path):
        files[path.name] = {"sha256": _sha256(path), "bytes": path.stat().st_size}
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
        "course_tags": _catalog_course_tags(record),
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
        "instructors": _catalog_instructors(teachers),
        "teaching_language": _as_optional_text(primary.get("teaching_language_zh")),
        "material_language": _as_optional_text(primary.get("material_language_zh")),
        "relations": _catalog_relations(outline),
        "teaching_methods": _catalog_weighted_options(
            outline.get("teaching_methods") or []
        ),
        "assessments": _catalog_weighted_options(outline.get("assessments") or []),
        "online_teaching": _catalog_online_teaching(
            outline.get("weekly_progress") or []
        ),
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


def _catalog_relations(outline: dict[str, Any]) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    for source_group in ("literacy", "core_competencies", "special_issues"):
        for item in outline.get(source_group) or []:
            relation = item.get("relation")
            if relation not in {1, 3}:
                continue
            core_no = item.get("core_no")
            item_no = item.get("item_no")
            if core_no is None or item_no is None:
                continue
            group = source_group
            if source_group == "core_competencies":
                group = "core_knowledge" if core_no == 6 else "core_skills_attitudes"
            result.append({
                "id": f"{core_no}:{item_no}",
                "group": group,
                "label": str(item.get("name") or ""),
                "strength": "direct" if relation == 3 else "indirect",
            })
    return result


def _catalog_weighted_options(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "id": str(item.get("method_sn")),
            "label": str(item.get("name_zh") or ""),
            "percent": float(item["percent"]),
        }
        for item in rows
        if item.get("method_sn") is not None and (item.get("percent") or 0) > 0
    ]


def _catalog_online_teaching(rows: list[dict[str, Any]]) -> dict[str, bool]:
    return {
        "sync": any((item.get("sync_online_hours") or 0) > 0 for item in rows),
        "async": any((item.get("async_online_hours") or 0) > 0 for item in rows),
    }


def _catalog_instructors(teachers: list[dict[str, Any]]) -> list[dict[str, str]]:
    instructors: list[dict[str, str]] = []
    seen: set[str] = set()
    for teacher in teachers:
        name_zh = str(teacher.get("name_zh") or "").strip()
        name_en = str(teacher.get("name_en") or "").strip()
        teacher_id = str(teacher.get("teacher_id") or "").strip()
        if not name_zh and not name_en:
            continue
        identity = teacher_id or f"name:{name_zh or name_en}"
        if identity in seen:
            continue
        seen.add(identity)
        instructors.append({"id": identity, "name_zh": name_zh})
    return instructors


def _legacy_instructors(course: dict[str, Any]) -> list[dict[str, str]]:
    name_zh = str(course.get("teacher") or "").strip()
    name_en = str(course.get("teacher_en") or "").strip()
    if not name_zh and not name_en:
        return []
    return [{"id": f"name:{name_zh or name_en}", "name_zh": name_zh, "name_en": name_en}]


def _compact_repeated_catalog_labels(catalog: list[dict[str, Any]]) -> None:
    """Keep option display metadata once while every course retains stable IDs."""

    for field, label_keys in (
        ("relations", ("label",)),
        ("teaching_methods", ("label", "label_en")),
        ("assessments", ("label", "label_en")),
        ("instructors", ("name_zh", "name_en")),
    ):
        seen: set[str] = set()
        for course in catalog:
            for option in course.get(field) or []:
                option_id = str(option.get("id") or "")
                if not option_id or option_id in seen:
                    for key in label_keys:
                        option.pop(key, None)
                else:
                    seen.add(option_id)


def _catalog_course_tags(record: dict[str, Any]) -> list[dict[str, Any]]:
    """Read normalized tags, with a raw-list fallback for older canonical data."""

    tags = record.get("course_tags")
    if tags is None:
        tags = ((record.get("raw") or {}).get("list_row") or {}).get("couClassifyList") or []
    return _normalize_catalog_course_tags(tags)


def _normalize_catalog_course_tags(tags: Any) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for tag in tags if isinstance(tags, list) else []:
        if not isinstance(tag, dict):
            continue
        code = tag.get("code", tag.get("couClassifyNo"))
        label_zh = tag.get("label_zh", tag.get("couClassifyCna"))
        if code is None or not label_zh:
            continue
        code = str(code)
        if code in seen:
            continue
        seen.add(code)
        normalized.append({
            "code": code,
            "label_zh": str(label_zh),
            "label_en": str(tag.get("label_en", tag.get("couClassifyEna")) or ""),
            "note_zh": str(tag.get("note_zh", tag.get("couClassifyNoteCna")) or ""),
            "note_en": str(tag.get("note_en", tag.get("couClassifyNoteEna")) or ""),
            "display_order": tag.get("display_order", tag.get("displayOrder")),
        })
    return sorted(
        normalized,
        key=lambda tag: (tag["display_order"] is None, tag["display_order"] or 0, tag["code"]),
    )


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


def _manifest_file_entries(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw_files = manifest.get("files")
    if isinstance(raw_files, dict):
        return {str(name): metadata for name, metadata in raw_files.items()}
    if isinstance(raw_files, list):
        entries: dict[str, dict[str, Any]] = {}
        for metadata in raw_files:
            if not isinstance(metadata, dict) or not metadata.get("filename"):
                raise ValueError("Artifact manifest has an invalid files entry")
            filename = str(metadata["filename"])
            if filename in entries:
                raise ValueError(f"Artifact manifest contains duplicate file entry: {filename}")
            entries[filename] = metadata
        return entries
    raise ValueError("Artifact manifest has no valid files section")


def _index_course_ids(index: dict[str, Any]) -> list[str]:
    if isinstance(index.get("course_ids"), list):
        return [str(course_id) for course_id in index["course_ids"]]
    rows = index.get("rows")
    if isinstance(rows, list):
        try:
            return [str(row["course_id"]) for row in rows]
        except (KeyError, TypeError) as exc:
            raise ValueError("Embedding index rows have no course_id") from exc
    raise ValueError("Embedding index has neither course_ids nor rows")


def _catalog_courses(catalog: Any) -> list[dict[str, Any]]:
    if isinstance(catalog, list):
        return catalog
    if isinstance(catalog, dict) and isinstance(catalog.get("courses"), list):
        return catalog["courses"]
    raise ValueError("Catalog must be a course list or an embedding catalog object")


def validate_artifacts(output_dir: Path, *, verify_hashes: bool = True) -> dict[str, Any]:
    manifest_path = output_dir / "artifact-manifest.json"
    if not manifest_path.exists():
        raise FileNotFoundError(manifest_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    entries = _manifest_file_entries(manifest)
    is_embedding_artifact_v1 = manifest.get("artifact_schema_version") == "fju_embedding_artifact_v1"
    required_files = (
        "catalog.json",
        "course-embeddings.f32",
        "embedding-index.json",
        "query-route-embeddings.f32",
        "query-route-index.json",
    )
    if is_embedding_artifact_v1:
        missing_entries = [name for name in required_files if name not in entries]
        if missing_entries:
            raise ValueError("Artifact manifest is missing files: " + ", ".join(missing_entries))
    for name, metadata in entries.items():
        if not isinstance(metadata, dict) or "bytes" not in metadata or "sha256" not in metadata:
            raise ValueError(f"Artifact manifest has invalid metadata: {name}")
        path = output_dir / name
        if not path.exists():
            raise FileNotFoundError(path)
        if path.stat().st_size != int(metadata["bytes"]):
            raise ValueError(f"Artifact size mismatch: {name}")
        if verify_hashes and _sha256(path) != str(metadata["sha256"]).lower():
            raise ValueError(f"Artifact checksum mismatch: {name}")

    if is_embedding_artifact_v1:
        expected = {
            "model_id": EMBEDDING_GEMMA_MODEL,
            "model_revision": EMBEDDING_GEMMA_REVISION,
            "tokenizer_revision": EMBEDDING_GEMMA_REVISION,
            "provider": "sentence-transformers",
            "dtype": "float32",
            "document_prompt_template": EMBEDDING_GEMMA_DOCUMENT_PROMPT,
            "query_prompt_template": EMBEDDING_GEMMA_QUERY_PROMPT,
        }
        for key, value in expected.items():
            if manifest.get(key) != value:
                raise ValueError(f"Artifact manifest compatibility mismatch: {key}")
        if int(manifest.get("dimension", 0)) not in {512, EMBEDDING_GEMMA_FULL_DIMENSION}:
            raise ValueError("EmbeddingGemma artifact dimension must be 512 or 768")
        if "L2 normalization" not in str(manifest.get("normalization", "")):
            raise ValueError("Artifact manifest does not declare L2 normalization")
        if int(manifest.get("query_route_count", 0)) != 5:
            raise ValueError("EmbeddingGemma artifact must contain five query routes")
        if int(manifest["dimension"]) == 512:
            derived = manifest.get("derived_from") or {}
            if (
                derived.get("method") != "first_512_dimensions_then_l2_normalize"
                or derived.get("model_inference") is not False
            ):
                raise ValueError("512 artifact does not declare the required derived-vector method")

    index = json.loads((output_dir / "embedding-index.json").read_text(encoding="utf-8"))
    course_ids = _index_course_ids(index)
    course_count = int(manifest["course_count"])
    dimension = int(manifest["dimension"])
    if len(course_ids) != course_count:
        raise ValueError("Embedding index count mismatch")
    if index.get("count") is not None and int(index["count"]) != course_count:
        raise ValueError("Embedding index count does not match manifest")
    if index.get("dimension") is not None and int(index["dimension"]) != dimension:
        raise ValueError("Embedding index dimension does not match manifest")
    catalog = orjson.loads((output_dir / "catalog.json").read_bytes())
    catalog_courses = _catalog_courses(catalog)
    catalog_ids = [str(item.get("course_id")) for item in catalog_courses]
    if len(catalog_courses) != course_count or catalog_ids != course_ids:
        raise ValueError("Catalog course IDs/order do not match embedding index")
    if isinstance(catalog, dict):
        if int(catalog.get("count", course_count)) != course_count:
            raise ValueError("Catalog count does not match manifest")
        if catalog.get("dimension") is not None and int(catalog["dimension"]) != dimension:
            raise ValueError("Catalog dimension does not match manifest")
    expected_bytes = course_count * dimension * 4
    if (output_dir / "course-embeddings.f32").stat().st_size != expected_bytes:
        raise ValueError("Embedding binary dimensions do not match manifest")
    if manifest.get("catalog_schema_version") == CATALOG_SCHEMA_VERSION:
        missing = [
            field
            for field in CATALOG_SCHEMA_FIELDS
            if any(field not in item for item in catalog_courses)
        ]
        if missing:
            raise ValueError(f"Catalog schema is missing fields: {', '.join(missing)}")

    route_index_path = output_dir / "query-route-index.json"
    route_vectors_path = output_dir / "query-route-embeddings.f32"
    if not route_index_path.exists() or not route_vectors_path.exists():
        if not is_embedding_artifact_v1 and manifest.get("artifact_version") != ARTIFACT_VERSION:
            return manifest
        raise FileNotFoundError(route_index_path)
    route_index = json.loads(route_index_path.read_text(encoding="utf-8"))
    route_count = int(
        manifest.get("query_route_count", manifest.get("route_count", route_index.get("route_count", route_index.get("count", 0))))
    )
    indexed_route_count = int(route_index.get("route_count", route_index.get("count", 0)))
    if route_count != indexed_route_count:
        raise ValueError("Route count does not match manifest")
    if route_index.get("dimension") != dimension:
        raise ValueError("Route embedding dimension does not match manifest")
    if route_index.get("model_revision") not in {None, manifest.get("model_revision")}:
        raise ValueError("Route model revision does not match manifest")
    if route_vectors_path.stat().st_size != route_count * dimension * 4:
        raise ValueError("Route embedding dimensions do not match manifest")
    routes = route_index.get("routes")
    if not isinstance(routes, list) or len(routes) != route_count:
        raise ValueError("Query route index rows do not match manifest")
    return manifest


def normalize_embedding_index(index: dict[str, Any], manifest: dict[str, Any]) -> dict[str, Any]:
    """Expose both legacy and incoming row-based indexes through one API shape."""

    normalized = dict(index)
    normalized.setdefault(
        "artifact_version",
        manifest.get("artifact_version") or manifest.get("artifact_schema_version") or ARTIFACT_VERSION,
    )
    normalized.setdefault("dimension", int(manifest["dimension"]))
    normalized.setdefault("dtype", "float32-le")
    if "course_ids" not in normalized:
        normalized["course_ids"] = _index_course_ids(index)
    return normalized


def _dataset_tag_from_artifact_dir(artifacts_dir: Path) -> str | None:
    match = re.match(r"^(\d{4})-", artifacts_dir.name)
    return match.group(1) if match else None


def _canonical_source_for_artifact(artifacts_dir: Path) -> Path:
    configured = os.environ.get("FJU_RECOMMENDER_CANONICAL_JSONL")
    if configured:
        return Path(configured)
    tag = _dataset_tag_from_artifact_dir(artifacts_dir)
    if not tag:
        raise FileNotFoundError(
            "Embedding catalog needs a full canonical catalog; set FJU_RECOMMENDER_CANONICAL_JSONL"
        )
    roots = [artifacts_dir.parents[1], Path.cwd()]
    candidates = []
    for root in roots:
        candidates.extend(
            sorted(
                root.glob(f"tmp/*/data/canonical/course_outlines_{tag}.jsonl"),
                key=lambda path: path.stat().st_mtime,
                reverse=True,
            )
        )
        candidates.extend(
            [
                root / "data" / "canonical" / f"course_outlines_{tag}.jsonl",
                root / "canonical" / f"course_outlines_{tag}.jsonl",
            ]
        )
    for candidate in dict.fromkeys(candidates):
        if candidate.exists():
            return candidate
    raise FileNotFoundError(
        "Full canonical catalog not found; set FJU_RECOMMENDER_CANONICAL_JSONL"
    )


def load_catalog_for_artifact(
    artifacts_dir: Path,
    manifest: dict[str, Any],
    index: dict[str, Any],
) -> list[dict[str, Any]]:
    """Load the full application catalog for legacy or vector-only artifacts."""

    raw_catalog = orjson.loads((artifacts_dir / "catalog.json").read_bytes())
    catalog_courses = _catalog_courses(raw_catalog)
    if isinstance(raw_catalog, list):
        return [normalize_catalog_course_schema(item) for item in catalog_courses]

    from .io import iter_jsonl

    source = _canonical_source_for_artifact(artifacts_dir)
    records = list(iter_jsonl(source) or [])
    expected_ids = _index_course_ids(index)
    catalog = [build_catalog_course(record) for record in records]
    _compact_repeated_catalog_labels(catalog)
    by_course_id = {str(item.get("course_id")): item for item in catalog}
    if len(by_course_id) != len(catalog) or set(by_course_id) != set(expected_ids):
        raise ValueError("Canonical catalog course IDs do not match embedding index")
    catalog = [by_course_id[course_id] for course_id in expected_ids]
    if len(catalog) != int(manifest["course_count"]):
        raise ValueError("Canonical catalog count does not match artifact manifest")
    return [normalize_catalog_course_schema(item) for item in catalog]


def _route_identity(route: dict[str, Any]) -> str:
    return str(route.get("id") or route.get("route_id") or "")


def validate_derived_artifact(
    base_dir: Path,
    alternate_dir: Path,
    *,
    tolerance: float = 2e-6,
) -> dict[str, Any]:
    """Verify a 512 artifact is the declared projection of a 768 artifact."""

    base_manifest = validate_artifacts(base_dir)
    alternate_manifest = validate_artifacts(alternate_dir)
    if int(base_manifest["dimension"]) != EMBEDDING_GEMMA_FULL_DIMENSION:
        raise ValueError("Derived-vector base artifact must be 768-dimensional")
    if int(alternate_manifest["dimension"]) != 512:
        raise ValueError("Derived-vector alternate artifact must be 512-dimensional")
    for key in ("model_revision", "tokenizer_revision", "provider", "dtype", "query_prompt_template"):
        if base_manifest.get(key) != alternate_manifest.get(key):
            raise ValueError(f"Derived artifacts disagree on {key}")
    if base_manifest.get("model_id") != alternate_manifest.get("model_id"):
        raise ValueError("Derived artifacts disagree on model_id")
    if base_manifest["course_count"] != alternate_manifest["course_count"]:
        raise ValueError("Derived artifacts disagree on course count")
    if base_manifest.get("query_route_count") != alternate_manifest.get("query_route_count"):
        raise ValueError("Derived artifacts disagree on query route count")
    derived = alternate_manifest.get("derived_from") or {}
    if derived.get("model_inference") is not False:
        raise ValueError("512 artifact declares unexpected model inference")
    base_index = json.loads((base_dir / "embedding-index.json").read_text(encoding="utf-8"))
    alternate_index = json.loads((alternate_dir / "embedding-index.json").read_text(encoding="utf-8"))
    if _index_course_ids(base_index) != _index_course_ids(alternate_index):
        raise ValueError("Derived artifacts disagree on course row order")
    base_routes = json.loads((base_dir / "query-route-index.json").read_text(encoding="utf-8"))
    alternate_routes = json.loads((alternate_dir / "query-route-index.json").read_text(encoding="utf-8"))
    if [_route_identity(route) for route in base_routes["routes"]] != [_route_identity(route) for route in alternate_routes["routes"]]:
        raise ValueError("Derived artifacts disagree on query route order")

    course_count = int(base_manifest["course_count"])
    base_vectors = np.memmap(
        base_dir / "course-embeddings.f32",
        dtype="<f4",
        mode="r",
        shape=(course_count, EMBEDDING_GEMMA_FULL_DIMENSION),
    )
    alternate_vectors = np.memmap(
        alternate_dir / "course-embeddings.f32",
        dtype="<f4",
        mode="r",
        shape=(course_count, 512),
    )
    course_prefix = np.asarray(base_vectors[:, :512], dtype=np.float32)
    course_expected = course_prefix / np.maximum(np.linalg.norm(course_prefix, axis=1, keepdims=True), 1e-12)
    course_max_abs_diff = float(np.max(np.abs(np.asarray(alternate_vectors) - course_expected)))

    route_count = int(base_manifest["query_route_count"])
    base_route_vectors = np.memmap(
        base_dir / "query-route-embeddings.f32",
        dtype="<f4",
        mode="r",
        shape=(route_count, EMBEDDING_GEMMA_FULL_DIMENSION),
    )
    alternate_route_vectors = np.memmap(
        alternate_dir / "query-route-embeddings.f32",
        dtype="<f4",
        mode="r",
        shape=(route_count, 512),
    )
    route_prefix = np.asarray(base_route_vectors[:, :512], dtype=np.float32)
    route_expected = route_prefix / np.maximum(np.linalg.norm(route_prefix, axis=1, keepdims=True), 1e-12)
    route_max_abs_diff = float(np.max(np.abs(np.asarray(alternate_route_vectors) - route_expected)))
    if course_max_abs_diff > tolerance or route_max_abs_diff > tolerance:
        raise ValueError("512 artifact is not the normalized first-512 projection of the 768 artifact")
    return {
        "base_dimension": EMBEDDING_GEMMA_FULL_DIMENSION,
        "alternate_dimension": 512,
        "course_max_abs_diff": course_max_abs_diff,
        "route_max_abs_diff": route_max_abs_diff,
    }


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
