from __future__ import annotations

import json
import logging
import math
import mimetypes
import os
import threading
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

import numpy as np
import orjson
import uvicorn
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .artifacts import (
    CATALOG_SCHEMA_VERSION,
    DEFAULT_MODEL,
    SentenceTransformerEncoder,
    normalize_catalog_course_schema,
    validate_artifacts,
)
from .query_routes import ANALYSIS_VERSION
from .rag import AIAskRequest, CourseRagService, RagError, UsageLedger

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - optional until the API dependency is installed
    def load_dotenv(*args, **kwargs):
        return False

load_dotenv(override=False)


logger = logging.getLogger(__name__)

APP_DIR = Path(__file__).resolve().parent
FRONTEND_DIST_ENV = os.environ.get("FJU_FRONTEND_DIST")
FRONTEND_DIST = (
    Path(FRONTEND_DIST_ENV)
    if FRONTEND_DIST_ENV and Path(FRONTEND_DIST_ENV).exists()
    else Path("frontend/dist")
    if (Path("frontend/dist") / "index.html").exists()
    else APP_DIR.parents[1] / "frontend" / "dist"
)
DEFAULT_ARTIFACTS_DIR = Path("data/artifacts/1151")
MAX_REQUEST_BYTES = 16 * 1024
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")


class QueryEmbeddingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=500)

    @field_validator("text")
    @classmethod
    def text_must_not_be_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("text must not be blank")
        return value


class QueryEmbeddingsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    texts: list[str] = Field(min_length=1, max_length=8)

    @field_validator("texts")
    @classmethod
    def texts_must_be_valid(cls, values: list[str]) -> list[str]:
        cleaned: list[str] = []
        for value in values:
            if not isinstance(value, str):
                raise ValueError("texts must contain strings")
            value = value.strip()
            if not value or len(value) > 500:
                raise ValueError("each text must contain 1-500 non-whitespace characters")
            cleaned.append(value)
        return cleaned


class CourseIdsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_ids: list[str] = Field(min_length=1, max_length=100)

    @field_validator("course_ids")
    @classmethod
    def course_ids_must_be_valid(cls, values: list[str]) -> list[str]:
        cleaned = [value.strip() for value in values]
        if any(not value or len(value) > 100 for value in cleaned):
            raise ValueError("course_ids must contain 1-100 non-whitespace characters")
        return list(dict.fromkeys(cleaned))


class CourseLookupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    values: list[str] = Field(min_length=1, max_length=100)

    @field_validator("values")
    @classmethod
    def values_must_be_valid(cls, values: list[str]) -> list[str]:
        cleaned = [value.strip() for value in values]
        if any(not value or len(value) > 200 for value in cleaned):
            raise ValueError("values must contain 1-200 non-whitespace characters")
        return list(dict.fromkeys(cleaned))


class ArtifactStore:
    def __init__(
        self,
        artifacts_dir: Path,
        *,
        verify_hashes: bool = True,
        department_catalog: dict[str, Any] | None = None,
    ) -> None:
        self.artifacts_dir = artifacts_dir
        self.manifest = validate_artifacts(artifacts_dir, verify_hashes=verify_hashes)
        raw_catalog = orjson.loads((artifacts_dir / "catalog.json").read_bytes())
        self.catalog = [normalize_catalog_course_schema(item) for item in raw_catalog]
        self.by_id = {str(item["course_id"]): item for item in self.catalog}
        self.index = orjson.loads((artifacts_dir / "embedding-index.json").read_bytes())
        self.department_catalog = (
            department_catalog
            or _load_department_catalog(artifacts_dir, int(self.manifest["academic_year"]))
            or _department_catalog_from_courses(self.catalog, int(self.manifest["academic_year"]))
        )
        if len(self.catalog) != self.manifest["course_count"]:
            raise ValueError("Catalog count does not match manifest")

    def facets(self) -> dict[str, Any]:
        return {
            "departments": _department_options(self.catalog),
            "grades": [
                {"value": str(value), "label": f"{value} 年級"}
                for value in sorted({item.get("grade") for item in self.catalog if item.get("grade")})
            ],
            "credits": [
                {"value": str(value), "label": f"{value:g} 學分"}
                for value in sorted({item.get("credits") for item in self.catalog if item.get("credits") is not None})
            ],
            "classes": _options(item.get("class_group") for item in self.catalog),
            "divisions": _options(item.get("division") for item in self.catalog),
            "required_elective": _options(
                item.get("required_elective_name") for item in self.catalog
            ),
            "course_tags": _course_tag_options(self.catalog),
            "eligibility_statuses": [
                {"value": "no_known_restriction", "label": "尚未判定出明確限制"},
                {"value": "needs_confirmation", "label": "需要確認"},
                {"value": "eligible_confirmed", "label": "確認可修"},
                {"value": "blocked_confirmed", "label": "確認不可修"},
            ],
        }

    def list_courses(
        self,
        *,
        q: str = "",
        department: str = "",
        grade: int | None = None,
        division: str = "",
        required_elective: str = "",
        course_tag: list[str] | None = None,
        weekday: int | None = None,
        section: str = "",
        page: int = 1,
        page_size: int = 25,
        sort: str = "name_zh",
    ) -> dict[str, Any]:
        query = q.strip().lower()
        items = []
        for item in self.catalog:
            if query and query not in _search_text(item):
                continue
            if department and not _department_filter_matches(item, department):
                continue
            if grade and item.get("grade") != grade:
                continue
            if division and item.get("division") != division:
                continue
            if required_elective and item.get("required_elective_name") != required_elective:
                continue
            if course_tag and not _course_tag_filter_matches(item, course_tag):
                continue
            if weekday and not any(meeting.get("weekday") == weekday for meeting in item["meetings"]):
                continue
            if section and not any(section in meeting.get("sections", []) for meeting in item["meetings"]):
                continue
            items.append(item)
        allowed_sort = {
            "name_zh",
            "department",
            "grade",
            "teacher",
            "credits",
            "ava_no",
        }
        sort_key = sort if sort in allowed_sort else "name_zh"
        items.sort(key=lambda item: (item.get(sort_key) is None, item.get(sort_key) or ""))
        total = len(items)
        start = (page - 1) * page_size
        return {
            "items": items[start : start + page_size],
            "page": page,
            "page_size": page_size,
            "total": total,
            "total_pages": max(1, math.ceil(total / page_size)),
        }


class QueryEncoder:
    def __init__(self, model_name: str) -> None:
        self.encoder = SentenceTransformerEncoder(model_name)
        self._lock = threading.Lock()

    @property
    def model_name(self) -> str:
        return self.encoder.model_name

    @property
    def model_revision(self) -> str:
        return self.encoder.model_revision

    def encode(self, text: str) -> np.ndarray:
        with self._lock:
            return self.encoder.encode_query(text)

    def encode_many(self, texts: list[str]) -> np.ndarray:
        with self._lock:
            if hasattr(self.encoder, "encode_many"):
                return np.asarray(self.encoder.encode_many(texts), dtype=np.float32)
            return np.stack([self.encoder.encode_query(text) for text in texts]).astype(np.float32)


class RateLimiter:
    def __init__(self, *, requests: int = 30, window_seconds: int = 60) -> None:
        self.requests = requests
        self.window_seconds = window_seconds
        self._events: defaultdict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        cutoff = now - self.window_seconds
        with self._lock:
            events = self._events[key]
            while events and events[0] < cutoff:
                events.popleft()
            if len(events) >= self.requests:
                return False
            events.append(now)
            return True


def create_app(
    *,
    store: ArtifactStore | None = None,
    query_encoder: QueryEncoder | Any | None = None,
    rag_service: CourseRagService | Any | None = None,
    load_runtime: bool = True,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if load_runtime and app.state.store is None:
            try:
                artifact_dir = Path(
                    os.environ.get("FJU_RECOMMENDER_ARTIFACTS_DIR", DEFAULT_ARTIFACTS_DIR)
                )
                app.state.store = ArtifactStore(
                    artifact_dir,
                    verify_hashes=os.environ.get("FJU_VERIFY_ARTIFACT_HASHES", "1") != "0",
                )
                model_name = app.state.store.manifest.get("model_name") or DEFAULT_MODEL
                app.state.query_encoder = QueryEncoder(model_name)
                if app.state.query_encoder.model_name != model_name:
                    raise ValueError("Query model does not match artifact model")
                test_vector = app.state.query_encoder.encode("課程推薦服務啟動檢查")
                if len(test_vector) != app.state.store.manifest["dimension"]:
                    raise ValueError("Query model dimension does not match artifact dimension")
                app.state.runtime_error = None
            except Exception as exc:  # noqa: BLE001
                app.state.runtime_error = str(exc)
        if app.state.store is not None and app.state.rag_service is None:
            app.state.rag_service = _build_rag_service(app.state.store.catalog)
        yield

    application = FastAPI(
        title="FJU Course Recommender",
        version="1.0.0",
        lifespan=lifespan,
    )
    application.state.store = store
    application.state.query_encoder = query_encoder
    application.state.rag_service = rag_service
    application.state.runtime_error = None
    application.state.rate_limiter = RateLimiter()
    application.state.ai_rate_limiter = RateLimiter(
        requests=max(1, _env_int("FJU_AI_REQUESTS_PER_MINUTE", 10, minimum=1, maximum=1000))
    )
    application.state.ai_error = None
    application.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=5)

    @application.middleware("http")
    async def enforce_request_size(request: Request, call_next):
        if request.method in {"POST", "PUT", "PATCH"}:
            content_length = request.headers.get("content-length")
            if content_length:
                try:
                    too_large = int(content_length) > MAX_REQUEST_BYTES
                except ValueError:
                    return JSONResponse({"detail": "Invalid Content-Length"}, status_code=400)
                if too_large:
                    return JSONResponse({"detail": "Request body too large"}, status_code=413)
            # Also cap chunked requests that do not provide Content-Length.
            if not content_length:
                body = await request.body()
                if len(body) > MAX_REQUEST_BYTES:
                    return JSONResponse({"detail": "Request body too large"}, status_code=413)
        return await call_next(request)

    register_routes(application)
    _mount_frontend(application)
    return application


def register_routes(application: FastAPI) -> None:
    def require_store(request: Request) -> ArtifactStore:
        store = request.app.state.store
        if store is None:
            raise HTTPException(status_code=503, detail=request.app.state.runtime_error or "Artifacts unavailable")
        return store

    @application.get("/health/live")
    def live() -> dict[str, str]:
        return {"status": "alive"}

    @application.get("/health/ready")
    def ready(request: Request) -> dict[str, Any]:
        if request.app.state.store is None or request.app.state.query_encoder is None:
            raise HTTPException(status_code=503, detail=request.app.state.runtime_error or "Runtime unavailable")
        return {
            "status": "ready",
            "artifact_version": request.app.state.store.manifest["artifact_version"],
            "model_name": request.app.state.store.manifest["model_name"],
            "query_planner_mode": "disabled",
            "compound_query_enabled": _compound_enabled(),
            "ai_assistant_enabled": request.app.state.rag_service is not None,
        }

    @application.get("/api/v1/catalog/manifest")
    def manifest(request: Request) -> dict[str, Any]:
        return require_store(request).manifest

    @application.get("/api/v1/facets")
    def facets_v1(request: Request) -> dict[str, Any]:
        return require_store(request).facets()

    @application.get("/api/v1/departments")
    def departments_v1(request: Request) -> dict[str, Any]:
        return require_store(request).department_catalog

    @application.get("/api/v1/catalog/data")
    def catalog_data(request: Request) -> Response:
        store = require_store(request)
        if store.manifest.get("catalog_schema_version") != CATALOG_SCHEMA_VERSION:
            # Legacy artifacts are normalized in ArtifactStore; return that
            # migrated view instead of serving the unnormalized JSON file.
            return JSONResponse(store.catalog, headers={"Cache-Control": "public, max-age=86400"})
        return FileResponse(
            store.artifacts_dir / "catalog.json",
            media_type="application/json",
            headers={"Cache-Control": "public, max-age=86400"},
        )

    @application.get("/api/v1/courses")
    def courses_v1(
        request: Request,
        q: str = "",
        department: str = "",
        grade: int | None = Query(None, ge=1, le=7),
        division: str = "",
        required_elective: str = "",
        course_tag: list[str] = Query(default=[]),
        weekday: int | None = Query(None, ge=1, le=7),
        section: str = "",
        page: int = Query(1, ge=1),
        page_size: int = Query(25, ge=5, le=100),
        sort: str = "name_zh",
    ) -> dict[str, Any]:
        return require_store(request).list_courses(
            q=q,
            department=department,
            grade=grade,
            division=division,
            required_elective=required_elective,
            course_tag=course_tag,
            weekday=weekday,
            section=section,
            page=page,
            page_size=page_size,
            sort=sort,
        )

    @application.get("/api/v1/class-groups")
    def class_groups_v1(
        request: Request,
        department: str = "",
        division: str = "",
        grade: int | None = Query(None, ge=1, le=7),
    ) -> dict[str, list[str]]:
        items = require_store(request).catalog
        values = sorted({
            str(item.get("class_group"))
            for item in items
            if item.get("class_group")
            and (not department or _department_filter_matches(item, department))
            and (not division or item.get("division") == division)
            and (grade is None or item.get("grade") == grade)
        })
        return {"items": values}

    @application.get("/api/v1/courses/{course_id}")
    def course_v1(course_id: str, request: Request) -> dict[str, Any]:
        item = require_store(request).by_id.get(str(course_id))
        if item is None:
            raise HTTPException(status_code=404, detail="Course not found")
        return item

    @application.post("/api/v1/courses/batch")
    def courses_batch_v1(payload: CourseIdsRequest, request: Request) -> dict[str, Any]:
        store = require_store(request)
        items = [store.by_id[course_id] for course_id in payload.course_ids if course_id in store.by_id]
        found_ids = {str(item["course_id"]) for item in items}
        return {
            "items": items,
            "missing_course_ids": [course_id for course_id in payload.course_ids if course_id not in found_ids],
        }

    @application.post("/api/v1/courses/lookup")
    def courses_lookup_v1(payload: CourseLookupRequest, request: Request) -> dict[str, Any]:
        catalog = require_store(request).catalog
        normalized = {value.casefold(): value for value in payload.values}
        matched_values: set[str] = set()
        items: list[dict[str, Any]] = []
        for item in catalog:
            candidates = {
                str(item.get("ava_no") or "").strip().casefold(),
                str(item.get("name_zh") or "").strip().casefold(),
            }
            matches = candidates.intersection(normalized)
            if not matches:
                continue
            items.append(item)
            matched_values.update(normalized[value] for value in matches)
        return {
            "items": items,
            "matched_values": [value for value in payload.values if value in matched_values],
            "unmatched_values": [value for value in payload.values if value not in matched_values],
        }

    @application.get("/api/v1/embeddings/index")
    def embeddings_index(request: Request) -> dict[str, Any]:
        return require_store(request).index

    @application.get("/api/v1/embeddings/data")
    def embeddings_data(request: Request) -> FileResponse:
        store = require_store(request)
        return FileResponse(
            store.artifacts_dir / "course-embeddings.f32",
            media_type="application/octet-stream",
            filename="course-embeddings.f32",
            headers={"Cache-Control": "public, max-age=86400, immutable"},
        )

    @application.get("/api/v1/features")
    def features() -> dict[str, Any]:
        return {
            "compound_query_enabled": _compound_enabled(),
            "query_analysis_version": ANALYSIS_VERSION,
            "ai_assistant_enabled": application.state.rag_service is not None,
            "ai_model": os.environ.get("FJU_AI_MODEL", "gpt-5.6-luna"),
            "ai_max_question_chars": _ai_max_question_chars(),
        }

    @application.post("/api/v1/ai/ask")
    def ai_ask(payload: AIAskRequest, request: Request) -> dict[str, Any]:
        service = request.app.state.rag_service
        if service is None:
            raise HTTPException(status_code=503, detail="AI 小幫手尚未設定 API key")
        client = request.client.host if request.client else "unknown"
        if not request.app.state.ai_rate_limiter.allow(client):
            raise HTTPException(status_code=429, detail="AI 詢問過於頻繁，請稍後再試。")
        try:
            return service.ask(payload)
        except RagError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc

    @application.get("/api/v1/query-routes/index")
    def query_routes_index(request: Request) -> dict[str, Any]:
        store = require_store(request)
        path = store.artifacts_dir / "query-route-index.json"
        if not path.exists():
            raise HTTPException(status_code=503, detail="Query route artifacts unavailable")
        return orjson.loads(path.read_bytes())

    @application.get("/api/v1/query-routes/data")
    def query_routes_data(request: Request) -> FileResponse:
        store = require_store(request)
        path = store.artifacts_dir / "query-route-embeddings.f32"
        if not path.exists():
            raise HTTPException(status_code=503, detail="Query route artifacts unavailable")
        return FileResponse(
            path,
            media_type="application/octet-stream",
            filename="query-route-embeddings.f32",
            headers={"Cache-Control": "public, max-age=86400, immutable"},
        )

    @application.post("/api/v1/query-embedding")
    def query_embedding(payload: QueryEmbeddingRequest, request: Request) -> dict[str, Any]:
        store = require_store(request)
        client = request.client.host if request.client else "unknown"
        if not request.app.state.rate_limiter.allow(client):
            raise HTTPException(status_code=429, detail="Too many embedding requests")
        encoder = request.app.state.query_encoder
        if encoder is None:
            raise HTTPException(status_code=503, detail="Embedding model unavailable")
        vector = np.asarray(encoder.encode(payload.text), dtype=np.float32)
        if vector.ndim != 1 or len(vector) != store.manifest["dimension"]:
            raise HTTPException(status_code=503, detail="Embedding model version mismatch")
        return {
            "vector": vector.tolist(),
            "model_version": store.manifest["model_revision"],
            "dimension": len(vector),
        }

    @application.post("/api/v1/query-embeddings")
    def query_embeddings(payload: QueryEmbeddingsRequest, request: Request) -> dict[str, Any]:
        store = require_store(request)
        client = request.client.host if request.client else "unknown"
        if not request.app.state.rate_limiter.allow(client):
            raise HTTPException(status_code=429, detail="Too many embedding requests")
        encoder = request.app.state.query_encoder
        if encoder is None:
            raise HTTPException(status_code=503, detail="Embedding model unavailable")
        vectors = np.asarray(encoder.encode_many(payload.texts), dtype=np.float32)
        if vectors.ndim != 2 or vectors.shape != (len(payload.texts), store.manifest["dimension"]):
            raise HTTPException(status_code=503, detail="Embedding model version mismatch")
        return {
            "vectors": vectors.tolist(),
            "model_version": store.manifest["model_revision"],
            "dimension": int(vectors.shape[1]),
        }

    # Legacy compatibility layer.
    @application.get("/api/summary")
    def legacy_summary(request: Request) -> dict[str, Any]:
        store = require_store(request)
        return {
            "courses": len(store.catalog),
            "departments": len({
                item.get("department_identity") or f"legacy:{item.get('department')}"
                for item in store.catalog
                if item.get("department")
            }),
            "teachers": len({item.get("teacher") for item in store.catalog}),
            "weekly_progress": sum(bool(item["sections"].get("weekly_progress")) for item in store.catalog),
            "relations": 0,
            "methods": 0,
            "assessments": sum(bool(item["sections"].get("assessment")) for item in store.catalog),
            "materials": sum(bool(item["sections"].get("materials")) for item in store.catalog),
        }

    @application.get("/api/facets")
    def legacy_facets(request: Request) -> dict[str, Any]:
        data = require_store(request).facets()
        return {
            **data,
            "required_elective": data["required_elective"],
            "outline_done": [{"value": "true", "label": "已完成"}],
            "class_availability": [],
        }

    @application.get("/api/courses")
    def legacy_courses(
        request: Request,
        q: str = "",
        department: str = "",
        grade: str = "",
        division: str = "",
        req: str = "",
        page: int = Query(1, ge=1),
        page_size: int = Query(25, ge=5, le=100),
        sort: str = "name_zh",
    ) -> dict[str, Any]:
        grade_value = int(grade[0]) if grade and grade[0].isdigit() else None
        return require_store(request).list_courses(
            q=q,
            department=department,
            grade=grade_value,
            division=division,
            required_elective=req,
            page=page,
            page_size=page_size,
            sort=sort,
        )

    @application.get("/api/courses/{course_id}")
    def legacy_course(course_id: str, request: Request) -> dict[str, Any]:
        item = require_store(request).by_id.get(str(course_id))
        if item is None:
            raise HTTPException(status_code=404, detail="Course not found")
        return {
            "course": item,
            "document": {"sections": item["sections"], "full_document_zh": ""},
            "weekly_progress": [],
            "relations": {},
            "teaching_methods": [],
            "assessments": [],
            "materials": [],
        }


class FrontendBuildMissingError(RuntimeError):
    """No built frontend bundle could be located.

    There is deliberately no fallback to an older bundled UI: silently serving a
    stale frontend makes a forgotten ``pnpm build`` look like a code change that
    had no effect.
    """


def _resolve_frontend_dist() -> Path:
    env_dir = os.environ.get("FJU_FRONTEND_DIST")
    candidates = [
        Path(env_dir) if env_dir else None,
        FRONTEND_DIST,
        Path("frontend/dist"),
    ]
    checked: list[str] = []
    for candidate in candidates:
        if candidate is None:
            continue
        if (candidate / "index.html").exists():
            return candidate
        checked.append(str(candidate))
    raise FrontendBuildMissingError(
        "找不到已建置的前端 index.html，後端拒絕以舊版介面遞補。\n"
        "請先建置前端：cd frontend && pnpm install && pnpm build\n"
        "或設定 FJU_FRONTEND_DIST 指向已建置的 dist 目錄。\n"
        "已檢查的路徑：" + ", ".join(checked)
    )


def _mount_frontend(application: FastAPI) -> None:
    try:
        static_dir = _resolve_frontend_dist()
    except FrontendBuildMissingError as error:
        # Fail loudly on stderr at startup, and keep failing loudly on every
        # request, instead of quietly serving something that is not the build.
        logger.error("%s", error)
        message = str(error)

        @application.get("/{path:path}", include_in_schema=False)
        def frontend_build_missing(path: str) -> Response:
            return PlainTextResponse(message, status_code=503)

        return

    assets_dir = static_dir / "assets"
    if assets_dir.exists():
        application.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @application.get("/{path:path}", include_in_schema=False)
    def spa(path: str) -> Response:
        candidate = static_dir / path
        if path and candidate.is_file() and static_dir.resolve() in candidate.resolve().parents:
            return FileResponse(candidate)
        return FileResponse(static_dir / "index.html")


def _build_rag_service(catalog: list[dict[str, Any]]) -> CourseRagService | None:
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        return None
    try:
        from openai import OpenAI

        client = OpenAI(
            api_key=api_key,
            timeout=float(_env_int("FJU_AI_TIMEOUT_SECONDS", 25, minimum=1, maximum=120)),
            max_retries=1,
        )
    except Exception:  # noqa: BLE001
        return None

    moderator = None
    if os.environ.get("FJU_AI_MODERATION_ENABLED", "1").strip().lower() in {"1", "true", "yes", "on"}:
        def moderate(text: str) -> bool:
            try:
                result = client.moderations.create(model="omni-moderation-latest", input=text)
                results = getattr(result, "results", None) or []
                return bool(results and getattr(results[0], "flagged", False))
            except Exception:  # noqa: BLE001
                # Course RAG has no tools or privileged actions; keep availability if moderation is unavailable.
                return False

        moderator = moderate

    ledger = UsageLedger(
        Path(os.environ.get("FJU_AI_USAGE_DB", "data/runtime/ai-usage.sqlite3")),
        monthly_limit=_env_int("FJU_AI_MONTHLY_REQUEST_LIMIT", 10000, minimum=1, maximum=1_000_000),
    )
    return CourseRagService(
        catalog,
        client=client,
        model=os.environ.get("FJU_AI_MODEL", "gpt-5.6-luna"),
        reasoning_effort=os.environ.get("FJU_AI_REASONING_EFFORT", "none"),
        max_output_tokens=_env_int("FJU_AI_MAX_OUTPUT_TOKENS", 1000, minimum=100, maximum=1000),
        ledger=ledger,
        moderator=moderator,
    )


def _env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


def _load_department_catalog(artifacts_dir: Path, academic_year: int) -> dict[str, Any] | None:
    configured = os.environ.get("FJU_DEPARTMENT_CATALOG")
    candidates = []
    if configured:
        candidates.append(Path(configured))
    try:
        data_dir = artifacts_dir.parents[1]
    except IndexError:
        data_dir = Path("data")
    candidates.append(data_dir / "reference" / f"departments_{academic_year}.json")
    for path in candidates:
        if path.exists():
            return orjson.loads(path.read_bytes())
    return None


def _department_catalog_from_courses(
    catalog: list[dict[str, Any]], academic_year: int
) -> dict[str, Any]:
    """Compatibility fallback for test/legacy deployments without the official artifact."""

    departments: dict[str, dict[str, Any]] = {}
    division_names: dict[str, str] = {}
    for item in catalog:
        code = str(item.get("department_code") or "").strip()
        division_code = str(item.get("division_code") or "").strip()
        division_name = str(item.get("division") or "").strip()
        name = str(item.get("official_department_name_zh") or item.get("department") or "").strip()
        if not code or not division_code or not division_name or not name:
            continue
        division_names[division_code] = division_name
        department_type = str(item.get("official_department_type") or "")
        key = f"{division_code}:{code}:{department_type}"
        departments.setdefault(key, {
            "division_code": division_code,
            "division_name_zh": division_name,
            "code": code,
            "label": str(item.get("official_department_label") or f"{code}-{name}"),
            "name_zh": name,
            "department_type": department_type,
        })
    flattened = list(departments.values())
    divisions = []
    for division_code, division_name in division_names.items():
        rows = [
            {key: value for key, value in row.items() if key not in {"division_code", "division_name_zh"}}
            for row in flattened
            if row["division_code"] == division_code
        ]
        divisions.append({
            "code": division_code,
            "label": f"{division_code}-{division_name}",
            "name_zh": division_name,
            "departments": rows,
        })
    return {
        "schema_version": "fju_department_catalog_fallback_v1",
        "hy": academic_year,
        "divisions": divisions,
        "departments": flattened,
    }


def _ai_max_question_chars() -> int:
    return _env_int("FJU_AI_MAX_QUESTION_CHARS", 500, minimum=1, maximum=500)


def _options(values) -> list[dict[str, str]]:
    unique = sorted({str(value) for value in values if value is not None and str(value).strip()})
    return [{"value": value, "label": value} for value in unique]


def _compound_enabled() -> bool:
    return os.environ.get("FJU_COMPOUND_QUERY_ENABLED", "0").strip().lower() in {"1", "true", "yes", "on"}


def _department_options(items: list[dict[str, Any]]) -> list[dict[str, str | None]]:
    options: dict[str, dict[str, str | None]] = {}
    for item in items:
        department = str(item.get("department") or "").strip()
        if not department:
            continue
        identity = str(item.get("department_identity") or f"legacy:{department}")
        options.setdefault(
            identity,
            {
                "value": identity,
                "label": str(
                    item.get("official_department_label")
                    or item.get("department_display")
                    or department
                ),
                "code": item.get("department_code"),
                "name_zh": item.get("official_department_name_zh"),
                "department_type": item.get("official_department_type"),
            },
        )
    return sorted(options.values(), key=lambda item: str(item.get("label") or ""))


def _department_filter_matches(item: dict[str, Any], value: str) -> bool:
    identity = item.get("department_identity")
    if identity:
        return str(identity) == value
    return str(item.get("department") or "") == value


def _course_tag_options(items: list[dict[str, Any]]) -> list[dict[str, str]]:
    options: dict[str, dict[str, Any]] = {}
    for item in items:
        for tag in item.get("course_tags") or []:
            code = str(tag.get("code") or "").strip()
            label = str(tag.get("label_zh") or "").strip()
            if not code or not label:
                continue
            options.setdefault(code, {
                "value": code,
                "label": label,
                "display_order": tag.get("display_order"),
            })
    return [
        {"value": item["value"], "label": item["label"]}
        for item in sorted(
            options.values(),
            key=lambda item: (item["display_order"] is None, item["display_order"] or 0, item["label"]),
        )
    ]


def _course_tag_filter_matches(item: dict[str, Any], selected_codes: list[str]) -> bool:
    selected = {str(code) for code in selected_codes if str(code).strip()}
    return bool(selected & {
        str(tag.get("code"))
        for tag in item.get("course_tags") or []
        if tag.get("code") is not None
    })


def _search_text(item: dict[str, Any]) -> str:
    return " ".join(
        str(item.get(key) or "")
        for key in (
            "name_zh",
            "name_en",
            "ava_no",
            "teacher",
            "teacher_en",
            "department",
            "department_display",
            "official_department_label",
            "division",
        )
    ).lower()


app = create_app()


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(prog="fju-outline-web")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--artifacts-dir", default=str(DEFAULT_ARTIFACTS_DIR))
    args = parser.parse_args()
    os.environ["FJU_RECOMMENDER_ARTIFACTS_DIR"] = args.artifacts_dir
    uvicorn.run("fju_outline.web:app", host=args.host, port=args.port, reload=False)


if __name__ == "__main__":
    main()
