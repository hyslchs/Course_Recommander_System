from __future__ import annotations

import json
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
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .artifacts import DEFAULT_MODEL, SentenceTransformerEncoder, validate_artifacts


APP_DIR = Path(__file__).resolve().parent
LEGACY_STATIC_DIR = APP_DIR / "web_assets"
FRONTEND_DIST = APP_DIR.parents[1] / "frontend" / "dist"
DEFAULT_ARTIFACTS_DIR = Path("data/artifacts/1151")
MAX_REQUEST_BYTES = 8 * 1024
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


class ArtifactStore:
    def __init__(self, artifacts_dir: Path, *, verify_hashes: bool = True) -> None:
        self.artifacts_dir = artifacts_dir
        self.manifest = validate_artifacts(artifacts_dir, verify_hashes=verify_hashes)
        self.catalog: list[dict[str, Any]] = orjson.loads(
            (artifacts_dir / "catalog.json").read_bytes()
        )
        self.by_id = {str(item["course_id"]): item for item in self.catalog}
        self.index = orjson.loads((artifacts_dir / "embedding-index.json").read_bytes())
        if len(self.catalog) != self.manifest["course_count"]:
            raise ValueError("Catalog count does not match manifest")

    def facets(self) -> dict[str, Any]:
        return {
            "departments": _options(item.get("department") for item in self.catalog),
            "grades": [
                {"value": str(value), "label": f"{value} 年級"}
                for value in sorted({item.get("grade") for item in self.catalog if item.get("grade")})
            ],
            "classes": _options(item.get("class_group") for item in self.catalog),
            "divisions": _options(item.get("division") for item in self.catalog),
            "required_elective": _options(
                item.get("required_elective_name") for item in self.catalog
            ),
            "eligibility_statuses": [
                {"value": "no_known_restriction", "label": "未發現限制"},
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
            if department and item.get("department") != department:
                continue
            if grade and item.get("grade") != grade:
                continue
            if division and item.get("division") != division:
                continue
            if required_elective and item.get("required_elective_name") != required_elective:
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
        yield

    application = FastAPI(
        title="FJU Course Recommender",
        version="1.0.0",
        lifespan=lifespan,
    )
    application.state.store = store
    application.state.query_encoder = query_encoder
    application.state.runtime_error = None
    application.state.rate_limiter = RateLimiter()

    @application.middleware("http")
    async def enforce_request_size(request: Request, call_next):
        if request.method in {"POST", "PUT", "PATCH"}:
            content_length = request.headers.get("content-length")
            if content_length and int(content_length) > MAX_REQUEST_BYTES:
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
        }

    @application.get("/api/v1/catalog/manifest")
    def manifest(request: Request) -> dict[str, Any]:
        return require_store(request).manifest

    @application.get("/api/v1/facets")
    def facets_v1(request: Request) -> dict[str, Any]:
        return require_store(request).facets()

    @application.get("/api/v1/catalog/data")
    def catalog_data(request: Request) -> Response:
        store = require_store(request)
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
            weekday=weekday,
            section=section,
            page=page,
            page_size=page_size,
            sort=sort,
        )

    @application.get("/api/v1/courses/{course_id}")
    def course_v1(course_id: str, request: Request) -> dict[str, Any]:
        item = require_store(request).by_id.get(str(course_id))
        if item is None:
            raise HTTPException(status_code=404, detail="Course not found")
        return item

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

    # Legacy compatibility layer.
    @application.get("/api/summary")
    def legacy_summary(request: Request) -> dict[str, Any]:
        store = require_store(request)
        return {
            "courses": len(store.catalog),
            "departments": len({item.get("department") for item in store.catalog}),
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


def _mount_frontend(application: FastAPI) -> None:
    static_dir = FRONTEND_DIST if (FRONTEND_DIST / "index.html").exists() else LEGACY_STATIC_DIR
    assets_dir = static_dir / "assets"
    if assets_dir.exists():
        application.mount("/assets", StaticFiles(directory=assets_dir), name="assets")
    legacy_assets = LEGACY_STATIC_DIR
    if legacy_assets.exists():
        application.mount("/static", StaticFiles(directory=legacy_assets), name="static")

    @application.get("/{path:path}", include_in_schema=False)
    def spa(path: str) -> Response:
        candidate = static_dir / path
        if path and candidate.is_file() and static_dir.resolve() in candidate.resolve().parents:
            return FileResponse(candidate)
        return FileResponse(static_dir / "index.html")


def _options(values) -> list[dict[str, str]]:
    unique = sorted({str(value) for value in values if value is not None and str(value).strip()})
    return [{"value": value, "label": value} for value in unique]


def _search_text(item: dict[str, Any]) -> str:
    return " ".join(
        str(item.get(key) or "")
        for key in ("name_zh", "name_en", "ava_no", "teacher", "teacher_en", "department", "division")
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
