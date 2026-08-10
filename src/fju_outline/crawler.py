from __future__ import annotations

import asyncio
from typing import Any

from tqdm import tqdm

from .client import FjuOutlineClient, FetchError
from .config import DEFAULT_LCID, DEFAULT_SCO_TYP
from .io import append_jsonl, write_jsonl
from .normalize import now_iso


LIST_ENDPOINT = "OutlineQuery/OutlineStudentQuery"
AVAILABLE_ENDPOINT = "OutlineQuery/CheckQueryAvailable"
DETAIL_ENDPOINTS = {
    "course_details": "OutlineMaintain/CourseDetailsData",
    "relations": "OutlineMaintain/CourseRelations",
    "info_and_book": "OutlineMaintain/CourseInfoAndBook",
    "course_progress": "OutlineMaintain/CourseCP",
    "methods": "OutlineMaintain/CourseMethods",
    "tch_leaves": "TchLeaves",
}


async def discover(
    client: FjuOutlineClient,
    *,
    hy: int,
    ht: int,
    sco_typ: int = DEFAULT_SCO_TYP,
    lcid: int = DEFAULT_LCID,
) -> dict[str, Any]:
    available = await client.get_json(
        AVAILABLE_ENDPOINT,
        scoTyp=sco_typ,
        hy=hy,
        ht=ht,
        PageNumber=1,
        PageSize=1,
        lcid=lcid,
    )
    first_page = await client.get_json(
        LIST_ENDPOINT,
        scoTyp=sco_typ,
        hy=hy,
        ht=ht,
        PageNumber=1,
        PageSize=1,
        lcid=lcid,
    )
    return {
        "available": available.data,
        "list_summary": first_page.data.get("result", {}),
        "transport": client.transport,
    }


async def crawl_all(
    client: FjuOutlineClient,
    *,
    paths: Any,
    hy: int,
    ht: int,
    page_size: int,
    concurrency: int,
    sco_typ: int = DEFAULT_SCO_TYP,
    lcid: int = DEFAULT_LCID,
    limit: int | None = None,
) -> dict[str, Any]:
    paths.ensure_dirs()
    first_page = await _fetch_list_page(
        client, hy=hy, ht=ht, page_number=1, page_size=page_size, sco_typ=sco_typ, lcid=lcid
    )
    summary = first_page.data["result"]
    total_pages = summary["totalPages"]
    rows = list(summary["result"])
    append_jsonl(paths.fetch_log_jsonl, _log_result(first_page))

    for page_number in tqdm(range(2, total_pages + 1), desc="course-list"):
        if limit and len(rows) >= limit:
            rows = rows[:limit]
            break
        result = await _fetch_list_page(
            client,
            hy=hy,
            ht=ht,
            page_number=page_number,
            page_size=page_size,
            sco_typ=sco_typ,
            lcid=lcid,
        )
        append_jsonl(paths.fetch_log_jsonl, _log_result(result))
        page_rows = result.data["result"]["result"]
        rows.extend(page_rows)
        if limit and len(rows) >= limit:
            rows = rows[:limit]
            break

    write_jsonl(paths.list_jsonl, rows)

    completed = _completed_ids(paths.raw_jsonl)
    pending = [row for row in rows if row.get("jonCouSn") not in completed]
    semaphore = asyncio.Semaphore(concurrency)
    failures: list[dict[str, Any]] = []

    async def worker(row: dict[str, Any]) -> None:
        async with semaphore:
            try:
                record = await fetch_course_outline(
                    client, row, hy=hy, ht=ht, sco_typ=sco_typ, lcid=lcid
                )
                append_jsonl(paths.raw_jsonl, record)
            except Exception as exc:  # noqa: BLE001 - record and continue full crawl.
                failure = {
                    "type": "course_failure",
                    "jonCouSn": row.get("jonCouSn"),
                    "avaNO": row.get("avaNO"),
                    "error": str(exc),
                    "fetched_at": now_iso(),
                }
                failures.append(failure)
                append_jsonl(paths.fetch_log_jsonl, failure)

    tasks = [asyncio.create_task(worker(row)) for row in pending]
    for task in tqdm(asyncio.as_completed(tasks), total=len(tasks), desc="course-details"):
        await task

    return {
        "transport": client.transport,
        "total_list_rows": len(rows),
        "already_completed": len(completed),
        "new_completed": len(pending) - len(failures),
        "failures": len(failures),
        "raw_path": str(paths.raw_jsonl),
        "list_path": str(paths.list_jsonl),
    }


async def fetch_course_outline(
    client: FjuOutlineClient,
    list_row: dict[str, Any],
    *,
    hy: int,
    ht: int,
    sco_typ: int = DEFAULT_SCO_TYP,
    lcid: int = DEFAULT_LCID,
) -> dict[str, Any]:
    jon_cou_sn = list_row["jonCouSn"]
    details_result = await client.get_json(
        DETAIL_ENDPOINTS["course_details"],
        jonCouSn=jon_cou_sn,
        lcid=lcid,
        fromStu="true",
    )
    details = details_result.data.get("result") or {}
    tch_no = details.get("tchNo") or list_row.get("tchNo")
    common = {"jonCouSn": jon_cou_sn, "tchNo": tch_no, "lcid": lcid}

    async def safe_get(name: str, endpoint: str, **params: Any) -> tuple[str, Any]:
        try:
            result = await client.get_json(endpoint, **params)
            return name, result.data
        except FetchError as exc:
            return name, {"statusCode": None, "result": None, "errorMessage": [str(exc)]}

    other_results = await asyncio.gather(
        safe_get("relations", DETAIL_ENDPOINTS["relations"], **common),
        safe_get("info_and_book", DETAIL_ENDPOINTS["info_and_book"], **common),
        safe_get("course_progress", DETAIL_ENDPOINTS["course_progress"], **common),
        safe_get("methods", DETAIL_ENDPOINTS["methods"], **common),
        safe_get("tch_leaves", DETAIL_ENDPOINTS["tch_leaves"], jonCouSn=jon_cou_sn),
    )
    record = {
        "hy": hy,
        "ht": ht,
        "scoTyp": sco_typ,
        "lcid": lcid,
        "fetched_at": now_iso(),
        "list_row": list_row,
        "course_details": details_result.data,
    }
    record.update(dict(other_results))
    return record


async def _fetch_list_page(
    client: FjuOutlineClient,
    *,
    hy: int,
    ht: int,
    page_number: int,
    page_size: int,
    sco_typ: int,
    lcid: int,
) -> Any:
    return await client.get_json(
        LIST_ENDPOINT,
        scoTyp=sco_typ,
        hy=hy,
        ht=ht,
        PageNumber=page_number,
        PageSize=page_size,
        lcid=lcid,
    )


def _completed_ids(raw_jsonl: Any) -> set[int]:
    from .io import iter_jsonl

    completed = set()
    for row in iter_jsonl(raw_jsonl) or []:
        jon = row.get("list_row", {}).get("jonCouSn")
        if jon is not None:
            completed.add(jon)
    return completed


def _log_result(result: Any) -> dict[str, Any]:
    return {
        "type": "fetch",
        "endpoint": result.endpoint,
        "params": result.params,
        "status_code": result.status_code,
        "elapsed_ms": result.elapsed_ms,
        "transport": result.transport,
        "fetched_at": now_iso(),
    }
