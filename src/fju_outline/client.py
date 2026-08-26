from __future__ import annotations

import asyncio
import json
import time
import urllib.parse
from dataclasses import dataclass
from typing import Any, Literal

from .config import BASE_URL, DEFAULT_RETRIES, DEFAULT_TIMEOUT_SECONDS


TransportName = Literal["auto", "scrapling", "httpx", "urllib"]


class FetchError(RuntimeError):
    pass


@dataclass(frozen=True)
class FetchResult:
    endpoint: str
    params: dict[str, Any]
    status_code: int | None
    elapsed_ms: int
    data: dict[str, Any]
    transport: str


class FjuOutlineClient:
    def __init__(
        self,
        *,
        base_url: str = BASE_URL,
        timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
        retries: int = DEFAULT_RETRIES,
        transport: TransportName = "auto",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.retries = retries
        self.transport = self._resolve_transport(transport)

    def _resolve_transport(self, transport: TransportName) -> str:
        if transport == "urllib":
            return "urllib"
        if transport == "httpx":
            self._import_httpx()
            return "httpx"
        if transport == "scrapling":
            self._import_scrapling()
            return "scrapling"
        try:
            self._import_scrapling()
            return "scrapling"
        except Exception:
            try:
                self._import_httpx()
                return "httpx"
            except Exception:
                return "urllib"

    @staticmethod
    def _import_scrapling() -> Any:
        from scrapling.fetchers import AsyncFetcher

        return AsyncFetcher

    @staticmethod
    def _import_httpx() -> Any:
        import httpx

        return httpx

    def make_url(self, endpoint: str, params: dict[str, Any]) -> str:
        query = urllib.parse.urlencode(
            {key: value for key, value in params.items() if value is not None}
        )
        return f"{self.base_url}/{endpoint.lstrip('/')}?{query}"

    async def get_json(self, endpoint: str, **params: Any) -> FetchResult:
        last_error: Exception | None = None
        for attempt in range(1, self.retries + 1):
            started = time.perf_counter()
            try:
                if self.transport == "scrapling":
                    data, status_code = await self._scrapling_get(endpoint, params)
                elif self.transport == "httpx":
                    data, status_code = await self._httpx_get(endpoint, params)
                else:
                    data, status_code = await self._urllib_get(endpoint, params)
                elapsed_ms = int((time.perf_counter() - started) * 1000)
                if not isinstance(data, dict):
                    raise FetchError(f"Expected JSON object from {endpoint}")
                return FetchResult(
                    endpoint=endpoint,
                    params=params,
                    status_code=status_code,
                    elapsed_ms=elapsed_ms,
                    data=data,
                    transport=self.transport,
                )
            except Exception as exc:  # noqa: BLE001 - retry and wrap final failure.
                last_error = exc
                if attempt < self.retries:
                    await asyncio.sleep(min(2**attempt, 8))
        raise FetchError(f"Failed to fetch {endpoint}: {last_error}") from last_error

    async def _scrapling_get(
        self, endpoint: str, params: dict[str, Any]
    ) -> tuple[dict[str, Any], int | None]:
        AsyncFetcher = self._import_scrapling()
        page = await AsyncFetcher.get(
            self.make_url(endpoint, params),
            stealthy_headers=True,
            timeout=self.timeout_seconds,
        )
        raw = self._response_text(page)
        status_code = getattr(page, "status", None) or getattr(page, "status_code", None)
        return json.loads(raw), status_code

    async def _httpx_get(
        self, endpoint: str, params: dict[str, Any]
    ) -> tuple[dict[str, Any], int | None]:
        httpx = self._import_httpx()
        async with httpx.AsyncClient(
            timeout=self.timeout_seconds,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (X11; Linux x86_64) "
                    "AppleWebKit/537.36 FJU-Outline-Research/0.1"
                ),
                "Accept": "application/json,text/plain,*/*",
            },
            follow_redirects=True,
        ) as client:
            response = await client.get(self.make_url(endpoint, params))
            response.raise_for_status()
            return response.json(), response.status_code

    async def _urllib_get(
        self, endpoint: str, params: dict[str, Any]
    ) -> tuple[dict[str, Any], int | None]:
        return await asyncio.to_thread(self._urllib_get_sync, endpoint, params)

    def _urllib_get_sync(
        self, endpoint: str, params: dict[str, Any]
    ) -> tuple[dict[str, Any], int | None]:
        import urllib.error
        import urllib.request

        request = urllib.request.Request(
            self.make_url(endpoint, params),
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (X11; Linux x86_64) "
                    "AppleWebKit/537.36 FJU-Outline-Research/0.1"
                ),
                "Accept": "application/json,text/plain,*/*",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                body = response.read().decode("utf-8")
                return json.loads(body), response.status
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise FetchError(f"HTTP {exc.code}: {body[:500]}") from exc

    @staticmethod
    def _response_text(response: Any) -> str:
        # Scrapling 0.4 exposes ``text`` as parsed selector text, which is
        # empty for JSON documents.  Prefer the unparsed response body so the
        # crawler works with both current and older Scrapling versions.
        for attr in ("body", "content", "text"):
            value = getattr(response, attr, None)
            if callable(value):
                value = value()
            if isinstance(value, bytes):
                return value.decode("utf-8")
            if isinstance(value, str):
                return value
        return str(response)
