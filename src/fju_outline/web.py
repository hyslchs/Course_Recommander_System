from __future__ import annotations

import json
import logging
import math
import mimetypes
import os
import secrets
import threading
import time
import unicodedata
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from ipaddress import ip_address, ip_network
from pathlib import Path
from typing import Any, AsyncIterator

import numpy as np
import orjson
import uvicorn
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .analytics import (
    MAX_EVENTS_PER_BATCH,
    AnalyticsRejection,
    AnalyticsCapacityError,
    AnalyticsStore,
    assert_no_forbidden_keys,
    build_store,
    validate_batch,
)
from .analytics_dashboard import DASHBOARD_HTML
from .artifacts import (
    CATALOG_SCHEMA_VERSION,
    DEFAULT_MODEL,
    encoder_from_manifest,
    load_catalog_for_artifact,
    normalize_embedding_index,
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
DEFAULT_ARTIFACTS_DIR = Path("new-vector-data/1151-embeddinggemma-768")
MAX_REQUEST_BYTES = 16 * 1024
DEVELOPMENT_TRUSTED_PROXY_IPS = "127.0.0.1,::1"
DOCS_PATHS = frozenset({"/docs", "/redoc", "/openapi.json"})
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
        self.manifest = dict(validate_artifacts(artifacts_dir, verify_hashes=verify_hashes))
        raw_index = orjson.loads((artifacts_dir / "embedding-index.json").read_bytes())
        self.index = normalize_embedding_index(raw_index, self.manifest)
        self.catalog = load_catalog_for_artifact(artifacts_dir, self.manifest, raw_index)
        self.by_id = {str(item["course_id"]): item for item in self.catalog}
        dataset_year = artifacts_dir.name.split("-", 1)[0]
        self.academic_year = int(
            self.manifest.get("academic_year")
            or os.environ.get("FJU_ACADEMIC_YEAR")
            or (dataset_year if dataset_year.isdigit() else 0)
        )
        self.semester = int(self.manifest.get("semester") or os.environ.get("FJU_SEMESTER") or 1)
        self.manifest.setdefault("model_name", self.manifest.get("model_id") or DEFAULT_MODEL)
        self.manifest.setdefault("artifact_version", self.manifest.get("artifact_schema_version", ""))
        self.manifest.setdefault("academic_year", self.academic_year)
        self.manifest.setdefault("semester", self.semester)
        self.department_catalog = (
            department_catalog
            or _load_department_catalog(artifacts_dir, self.academic_year)
            or _department_catalog_from_courses(self.catalog, self.academic_year)
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
            "relations": _relation_options(self.catalog),
            "teaching_methods": _weighted_options(self.catalog, "teaching_methods"),
            "assessments": _weighted_options(self.catalog, "assessments"),
            "teaching_languages": _counted_options(
                item.get("teaching_language") for item in self.catalog
            ),
            "material_languages": _counted_options(
                item.get("material_language") for item in self.catalog
            ),
            "teachers": _teacher_options(self.catalog),
            "sections": _section_options(self.catalog),
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
    def __init__(self, model_name: str | None = None, *, manifest: dict[str, Any] | None = None) -> None:
        self.manifest = dict(manifest or {})
        self.encoder = (
            encoder_from_manifest(self.manifest)
            if self.manifest
            else encoder_from_manifest({"model_name": model_name or DEFAULT_MODEL})
        )
        self._lock = threading.Lock()
        self._cache: dict[tuple[str, str, int, str, str], np.ndarray] = {}
        self._cache_limit = max(1, _env_int("FJU_QUERY_CACHE_MAX_ENTRIES", 256, minimum=1, maximum=10000))
        self._cache_hits = 0
        self._cache_misses = 0

    @property
    def model_name(self) -> str:
        return self.encoder.model_name

    @property
    def model_revision(self) -> str:
        return self.encoder.model_revision

    @property
    def dimension(self) -> int | None:
        value = self.manifest.get("dimension") or getattr(self.encoder, "dimension", None)
        return int(value) if value is not None else None

    def _cache_key(self, text: str) -> tuple[str, str, int, str, str]:
        normalized_text = " ".join(unicodedata.normalize("NFKC", text).split())
        model = str(self.manifest.get("model_id") or self.manifest.get("model_name") or self.model_name)
        revision = str(self.manifest.get("model_revision") or self.model_revision)
        dimension = int(self.manifest.get("dimension") or self.dimension or 0)
        prompt_identity = "|".join(
            [
                str(self.manifest.get("query_prompt_version") or "legacy-query-v1"),
                str(
                    self.manifest.get("query_prompt_template")
                    or (
                        "task: search result | query: {query}"
                        if model.startswith("google/embeddinggemma-")
                        else "query: {query}"
                    )
                ),
            ]
        )
        return model, revision, dimension, prompt_identity, normalized_text

    def _cache_put(self, key: tuple[str, str, int, str, str], vector: np.ndarray) -> None:
        if len(self._cache) >= self._cache_limit:
            self._cache.pop(next(iter(self._cache)))
        self._cache[key] = np.asarray(vector, dtype=np.float32).copy()

    def encode(self, text: str) -> np.ndarray:
        with self._lock:
            key = self._cache_key(text)
            cached = self._cache.get(key)
            if cached is not None:
                self._cache_hits += 1
                return cached.copy()
            self._cache_misses += 1
            vector = np.asarray(self.encoder.encode_query(text), dtype=np.float32)
            self._cache_put(key, vector)
            return vector.copy()

    def encode_many(self, texts: list[str]) -> np.ndarray:
        with self._lock:
            keys = [self._cache_key(text) for text in texts]
            results: list[np.ndarray | None] = [None] * len(texts)
            missing: list[tuple[int, str, tuple[str, str, int, str, str]]] = []
            for index, (text, key) in enumerate(zip(texts, keys)):
                cached = self._cache.get(key)
                if cached is None:
                    missing.append((index, text, key))
                else:
                    self._cache_hits += 1
                    results[index] = cached.copy()
            if missing:
                unique: list[tuple[str, tuple[str, str, int, str, str]]] = []
                seen: set[tuple[str, str, int, str, str]] = set()
                for _, text, key in missing:
                    if key not in seen:
                        seen.add(key)
                        unique.append((text, key))
                unique_texts = [text for text, _ in unique]
                if hasattr(self.encoder, "encode_many"):
                    encoded = np.asarray(self.encoder.encode_many(unique_texts), dtype=np.float32)
                else:
                    encoded = np.stack([self.encoder.encode_query(text) for text in unique_texts]).astype(np.float32)
                if encoded.ndim != 2 or encoded.shape[0] != len(unique):
                    raise ValueError("Query encoder returned an invalid batch shape")
                by_key: dict[tuple[str, str, int, str, str], np.ndarray] = {}
                for row, (_, key) in zip(encoded, unique):
                    self._cache_misses += 1
                    self._cache_put(key, row)
                    by_key[key] = np.asarray(row, dtype=np.float32)
                for index, _, key in missing:
                    results[index] = by_key[key].copy()
            return np.stack([result for result in results if result is not None]).astype(np.float32)

    def cache_stats(self) -> dict[str, int]:
        with self._lock:
            return {
                "entries": len(self._cache),
                "hits": self._cache_hits,
                "misses": self._cache_misses,
            }


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


def _trusted_proxy_networks() -> list[Any]:
    """Return trusted peer networks, failing closed for production misconfigurations."""
    environment = os.environ.get("FJU_ENV", "production").strip().lower()
    configured = os.environ.get("FJU_TRUSTED_PROXY_IPS", "").strip()
    networks = []
    if not configured:
        if environment in {"development", "dev", "test"}:
            configured = DEVELOPMENT_TRUSTED_PROXY_IPS
        else:
            logger.error(
                "security_event=trusted_proxy_config_missing environment=%s",
                environment or "production",
            )
            return []

    for value in configured.split(","):
        value = value.strip()
        if not value:
            continue
        try:
            networks.append(ip_network(value, strict=False))
        except ValueError:
            # A malformed production allowlist must not partially enable proxy
            # trust. No header is accepted if any configured entry is invalid.
            logger.error(
                "security_event=trusted_proxy_config_invalid environment=%s",
                environment or "production",
            )
            return []
    if not networks:
        logger.error(
            "security_event=trusted_proxy_config_invalid environment=%s",
            environment or "production",
        )
        return []
    return networks


def get_rate_limit_client_key(request: Request) -> str:
    """Return a rate-limit key without unconditionally trusting proxy headers.

    ``CF-Connecting-IP`` is accepted only from the configured local/cloudflared
    upstream. Generic forwarded headers are deliberately ignored. The returned
    key is used only in memory and is never persisted or logged.
    """
    peer = request.client.host if request.client else "unknown"
    if not peer or peer == "unknown":
        return "peer:unknown"
    try:
        peer_address = ip_address(peer)
    except ValueError:
        return f"peer:{peer}"
    if any(peer_address in network for network in _trusted_proxy_networks()):
        supplied = request.headers.get("cf-connecting-ip", "").strip()
        try:
            client_address = ip_address(supplied)
        except ValueError:
            client_address = None
        if client_address is not None:
            return f"cf:{client_address.compressed}"
    return f"peer:{peer_address.compressed}"


def _allow_rate_limit(request: Request, limiter: RateLimiter, endpoint: str) -> bool:
    if limiter.allow(get_rate_limit_client_key(request)):
        return True
    logger.warning("security_event=rate_limit_hit endpoint=%s", endpoint)
    return False


def _openai_api_key_configured() -> bool:
    return bool(os.environ.get("OPENAI_API_KEY", "").strip())


def _api_docs_enabled() -> bool:
    explicit = os.environ.get("FJU_ENABLE_API_DOCS", "").strip().lower()
    if explicit in {"1", "true", "yes", "on"}:
        return True
    if explicit in {"0", "false", "no", "off"}:
        return False
    environment = os.environ.get("FJU_ENV", "production").strip().lower()
    return environment in {"development", "dev", "test"}


def create_app(
    *,
    store: ArtifactStore | None = None,
    query_encoder: QueryEncoder | Any | None = None,
    rag_service: CourseRagService | Any | None = None,
    analytics_store: AnalyticsStore | None = None,
    load_runtime: bool = True,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if load_runtime and app.state.analytics_store is None:
            try:
                app.state.analytics_store = build_store()
            except Exception as exc:  # noqa: BLE001 - analytics must never block boot
                logger.warning("security_event=analytics_store_unavailable error_type=%s", type(exc).__name__)
        if app.state.analytics_store is not None:
            # Retention is enforced on every boot as well as during traffic, so a
            # service that sits idle past a window still expires its rows.
            try:
                app.state.analytics_store.maintain(force=True)
            except Exception as exc:  # noqa: BLE001
                logger.warning("security_event=analytics_maintenance_failure error_type=%s", type(exc).__name__)
        if load_runtime and app.state.store is None:
            try:
                artifact_dir = Path(
                    os.environ.get("FJU_RECOMMENDER_ARTIFACTS_DIR", DEFAULT_ARTIFACTS_DIR)
                )
                app.state.store = ArtifactStore(
                    artifact_dir,
                    verify_hashes=os.environ.get("FJU_VERIFY_ARTIFACT_HASHES", "1") != "0",
                )
                manifest = app.state.store.manifest
                model_name = manifest.get("model_id") or manifest.get("model_name") or DEFAULT_MODEL
                app.state.query_encoder = QueryEncoder(manifest=manifest)
                if app.state.query_encoder.model_name != model_name:
                    raise ValueError("Query model does not match artifact model")
                test_vector = app.state.query_encoder.encode("課程推薦服務啟動檢查")
                if len(test_vector) != int(manifest["dimension"]):
                    raise ValueError("Query model dimension does not match artifact dimension")
                app.state.runtime_error = None
            except Exception as exc:  # noqa: BLE001
                logger.error("security_event=artifact_integrity_failure error_type=%s", type(exc).__name__)
                app.state.runtime_error = "Runtime unavailable"
        if app.state.store is not None and app.state.rag_service is None and app.state.ai_configured:
            app.state.rag_service = _build_rag_service(app.state.store.catalog)
        yield

    docs_enabled = _api_docs_enabled()
    application = FastAPI(
        title="FJU Course Recommender",
        version="1.0.0",
        lifespan=lifespan,
        docs_url="/docs" if docs_enabled else None,
        redoc_url="/redoc" if docs_enabled else None,
        openapi_url="/openapi.json" if docs_enabled else None,
    )
    application.state.store = store
    application.state.query_encoder = query_encoder
    application.state.ai_configured = _openai_api_key_configured()
    application.state.rag_service = rag_service if application.state.ai_configured else None
    application.state.analytics_store = analytics_store
    application.state.runtime_error = None
    application.state.rate_limiter = RateLimiter()
    application.state.ai_rate_limiter = RateLimiter(
        requests=max(1, _env_int("FJU_AI_REQUESTS_PER_MINUTE", 10, minimum=1, maximum=1000))
    )
    # A batch carries up to 40 events, so 60 batches/minute is ~2400 events per
    # client per minute — far above any real session and low enough that a
    # single client cannot flood the table. The limiter key is resolved by the
    # centralized deployment-aware helper and keeps nothing but a deque of
    # monotonic timestamps in memory.
    application.state.analytics_rate_limiter = RateLimiter(
        requests=_env_int("FJU_ANALYTICS_REQUESTS_PER_MINUTE", 60, minimum=1, maximum=1000)
    )
    application.state.analytics_admin_rate_limiter = RateLimiter(
        requests=_env_int("FJU_ANALYTICS_ADMIN_REQUESTS_PER_MINUTE", 5, minimum=1, maximum=100)
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

    @application.middleware("http")
    async def security_hardening(request: Request, call_next):
        if not docs_enabled and request.url.path.rstrip("/") in DOCS_PATHS:
            response = JSONResponse({"detail": "Not Found"}, status_code=404)
        else:
            response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; base-uri 'self'; object-src 'none'; "
            "frame-ancestors 'none'; form-action 'self'; frame-src 'none'; "
            "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
            "font-src 'self'; img-src 'self' data: blob:; media-src 'self'; connect-src 'self'"
            if not docs_enabled
            else
            "default-src 'self'; base-uri 'self'; object-src 'none'; "
            "frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
            "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; "
            "img-src 'self' data: blob:; connect-src 'self'"
        )
        return response

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
            "ai_assistant_enabled": (
                request.app.state.rag_service is not None
                and request.app.state.ai_configured
                and _openai_api_key_configured()
            ),
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
            "analytics_enabled": application.state.analytics_store is not None,
            "ai_assistant_enabled": (
                application.state.rag_service is not None
                and application.state.ai_configured
                and _openai_api_key_configured()
            ),
            "ai_model": os.environ.get("FJU_AI_MODEL", "gpt-5.6-luna"),
            "ai_max_question_chars": _ai_max_question_chars(),
        }

    # ----------------------------------------------------------------- #
    # Analytics
    #
    # `AnalyticsBatch` is deliberately *not* a nested Pydantic model of the
    # event shape. Each event is validated by `analytics.validate_event`
    # against a per-event allowlist, because a single Pydantic model able to
    # describe fifteen different `data` shapes ends up permissive at the union
    # boundaries. Pydantic's job here is only "a list of objects, bounded".
    # ----------------------------------------------------------------- #

    @application.post("/api/v1/analytics/events", status_code=202)
    async def analytics_events(request: Request) -> Response:
        store = request.app.state.analytics_store
        if store is None:
            # 202 with a no-op body: the client is fire-and-forget and an error
            # status would only make it retry work that has nowhere to land.
            return JSONResponse({"accepted": 0, "rejected": 0}, status_code=202)

        if not _allow_rate_limit(request, request.app.state.analytics_rate_limiter, "analytics_events"):
            raise HTTPException(status_code=429, detail="Too many analytics requests")

        try:
            payload = orjson.loads(await request.body())
        except orjson.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Invalid JSON") from None
        if not isinstance(payload, dict) or not isinstance(payload.get("events"), list):
            raise HTTPException(status_code=400, detail="Expected {\"events\": [...]}")
        events = payload["events"]
        if len(events) > MAX_EVENTS_PER_BATCH:
            raise HTTPException(status_code=413, detail="Too many events in one batch")

        # Denylist first, on the raw body, before anything is projected. A
        # payload carrying `email`/`student_id`/`token`/`schedule` is a bug or an
        # attack; either way it fails loudly rather than being silently trimmed.
        try:
            assert_no_forbidden_keys(payload)
        except AnalyticsRejection as error:
            raise HTTPException(status_code=400, detail=str(error)) from None

        catalog = request.app.state.store
        course_exists = (lambda course_id: course_id in catalog.by_id) if catalog else None
        accepted, rejected = validate_batch(events, course_exists=course_exists, derive_event_id=True)
        try:
            written = store.record(accepted, user_agent=request.headers.get("user-agent"))
            store.maintain()
        except AnalyticsCapacityError:
            logger.warning("security_event=analytics_capacity_reject")
            written = 0
        except Exception as exc:  # noqa: BLE001 - analytics never breaks the app
            logger.warning("security_event=analytics_write_failure error_type=%s", type(exc).__name__)
            written = 0
        return JSONResponse({"accepted": written, "rejected": len(rejected)}, status_code=202)

    def _require_analytics_admin(request: Request) -> AnalyticsStore:
        expected = os.environ.get("FJU_ANALYTICS_ADMIN_TOKEN", "").strip()
        if not expected:
            # Never open by default: an unset token means the report is off, not
            # that anyone may read it.
            logger.warning("security_event=analytics_admin_auth_unavailable")
            raise HTTPException(status_code=503, detail="FJU_ANALYTICS_ADMIN_TOKEN is not configured")
        supplied = request.headers.get("x-analytics-token", "")
        if not secrets.compare_digest(supplied, expected):
            logger.warning("security_event=analytics_admin_auth_failure")
            raise HTTPException(status_code=401, detail="Invalid analytics token")
        store = request.app.state.analytics_store
        if store is None:
            raise HTTPException(status_code=503, detail="Analytics storage is disabled")
        return store

    @application.get("/api/v1/analytics/report")
    def analytics_report(
        request: Request,
        days: int = Query(30, ge=1, le=400),
        course_limit: int = Query(25, ge=1, le=500),
    ) -> dict[str, Any]:
        if not _allow_rate_limit(
            request,
            request.app.state.analytics_admin_rate_limiter,
            "analytics_report",
        ):
            raise HTTPException(status_code=429, detail="Too many analytics report requests")
        return _require_analytics_admin(request).report(days=days, course_limit=course_limit)

    @application.get("/api/v1/analytics/dashboard", include_in_schema=False)
    def analytics_dashboard() -> Response:
        # The page itself is data-free; it prompts for the token and calls the
        # report endpoint above, which is the thing that is actually guarded.
        return HTMLResponse(DASHBOARD_HTML, headers={"Cache-Control": "no-store"})

    @application.post("/api/v1/ai/ask")
    def ai_ask(payload: AIAskRequest, request: Request) -> dict[str, Any]:
        if not _allow_rate_limit(request, request.app.state.ai_rate_limiter, "ai_ask"):
            raise HTTPException(status_code=429, detail="AI 詢問過於頻繁，請稍後再試。")
        if not _openai_api_key_configured() or not request.app.state.ai_configured:
            logger.info("security_event=ai_feature_disabled reason=missing_api_key")
            raise HTTPException(status_code=503, detail="AI 小幫手尚未設定 API key")
        service = request.app.state.rag_service
        if service is None:
            logger.info("security_event=ai_provider_unavailable")
            raise HTTPException(status_code=503, detail="AI 小幫手尚未設定 API key")
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
        raw = orjson.loads(path.read_bytes())
        routes = []
        for route in raw.get("routes", []):
            item = dict(route)
            item.setdefault("id", item.get("route_id"))
            item.setdefault("label", item.get("query_text") or item.get("route_id"))
            item.setdefault("policy", "soft")
            routes.append(item)
        normalized = dict(raw)
        normalized["routes"] = routes
        normalized.setdefault("route_count", int(raw.get("count", len(routes))))
        normalized.setdefault("dimension", int(store.manifest["dimension"]))
        normalized.setdefault("model_name", store.manifest.get("model_name"))
        normalized.setdefault("model_revision", store.manifest.get("model_revision"))
        return normalized

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
        if not _allow_rate_limit(request, request.app.state.rate_limiter, "query_embedding"):
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
        if not _allow_rate_limit(request, request.app.state.rate_limiter, "query_embeddings"):
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
        logger.info("security_event=ai_feature_disabled reason=missing_api_key")
        return None
    try:
        from openai import OpenAI

        client = OpenAI(
            api_key=api_key,
            timeout=float(_env_int("FJU_AI_TIMEOUT_SECONDS", 25, minimum=1, maximum=120)),
            max_retries=1,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("security_event=ai_provider_unavailable error_type=%s", type(exc).__name__)
        return None

    moderator = None
    if os.environ.get("FJU_AI_MODERATION_ENABLED", "1").strip().lower() in {"1", "true", "yes", "on"}:
        def moderate(text: str) -> bool:
            try:
                result = client.moderations.create(model="omni-moderation-latest", input=text)
                results = getattr(result, "results", None) or []
                return bool(results and getattr(results[0], "flagged", False))
            except Exception as exc:  # noqa: BLE001
                # Course RAG has no tools or privileged actions; keep availability if moderation is unavailable.
                logger.warning("security_event=ai_moderation_unavailable error_type=%s", type(exc).__name__)
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
    candidates.append(data_dir / "data" / "reference" / f"departments_{academic_year}.json")
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


def _counted_options(values) -> list[dict[str, Any]]:
    counts: dict[str, int] = {}
    for value in values:
        label = str(value or "").strip()
        if label:
            counts[label] = counts.get(label, 0) + 1
    return [
        {"value": value, "label": value, "count": count}
        for value, count in sorted(counts.items())
    ]


def _relation_options(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    options: dict[str, dict[str, Any]] = {}
    seen_related: dict[str, set[str]] = {}
    seen_direct: dict[str, set[str]] = {}
    for course in items:
        course_id = str(course.get("course_id") or "")
        for relation in course.get("relations") or []:
            value = str(relation.get("id") or "")
            if not value:
                continue
            options.setdefault(value, {
                "value": value,
                "label": str(relation.get("label") or value),
                "group": str(relation.get("group") or ""),
            })
            seen_related.setdefault(value, set()).add(course_id)
            if relation.get("strength") == "direct":
                seen_direct.setdefault(value, set()).add(course_id)
    return [
        {
            **option,
            "count": len(seen_related.get(value, set())),
            "direct_count": len(seen_direct.get(value, set())),
        }
        for value, option in sorted(
            options.items(), key=lambda pair: (pair[1]["group"], pair[1]["label"])
        )
    ]


def _weighted_options(items: list[dict[str, Any]], field: str) -> list[dict[str, Any]]:
    options: dict[str, dict[str, Any]] = {}
    courses: dict[str, set[str]] = {}
    for course in items:
        course_id = str(course.get("course_id") or "")
        for option in course.get(field) or []:
            value = str(option.get("id") or "")
            if not value:
                continue
            options.setdefault(value, {
                "value": value,
                "label": str(option.get("label") or value),
                "label_en": str(option.get("label_en") or ""),
            })
            courses.setdefault(value, set()).add(course_id)
    return [
        {**option, "count": len(courses.get(value, set()))}
        for value, option in sorted(options.items(), key=lambda pair: int(pair[0]))
    ]


def _teacher_options(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    options: dict[str, dict[str, Any]] = {}
    courses: dict[str, set[str]] = {}
    for course in items:
        course_id = str(course.get("course_id") or "")
        for teacher in course.get("instructors") or []:
            value = str(teacher.get("id") or "")
            if not value:
                continue
            options.setdefault(value, {
                "value": value,
                "label": str(teacher.get("name_zh") or teacher.get("name_en") or value),
                "label_en": str(teacher.get("name_en") or ""),
            })
            courses.setdefault(value, set()).add(course_id)
    return [
        {**option, "count": len(courses.get(value, set()))}
        for value, option in sorted(options.items(), key=lambda pair: pair[1]["label"])
    ]


def _section_options(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    official = [
        "D0", "D1", "D2", "D3", "D4", "DN", "D5", "D6", "D7", "D8",
        "E0", "E1", "E2", "E3", "E4",
    ]
    courses = {section: set() for section in official}
    for course in items:
        course_id = str(course.get("course_id") or "")
        for meeting in course.get("meetings") or []:
            for section in meeting.get("sections") or []:
                if section in courses:
                    courses[section].add(course_id)
    return [
        {"value": section, "label": section, "count": len(courses[section])}
        for section in official
    ]


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
