from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .config import DEFAULT_LCID, DEFAULT_SCO_TYP, SOURCE_VIEW_URL
from .departments import enrich_organization_department
from .eligibility import infer_audience_grade, infer_study_level, normalize_audience_department


RELATION_LABELS = {
    0: "無關",
    1: "間接相關",
    3: "直接相關",
}

RELATION_BUCKETS = {
    1: "literacy",
    5: "special_issues",
    6: "core_knowledge",
    8: "core_skills_attitudes",
    10: "sdgs",
    11: "innovation_features",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def normalize_course_record(
    raw: dict[str, Any],
    *,
    department_catalog: dict[str, Any] | None = None,
) -> dict[str, Any]:
    list_row = raw["list_row"]
    detail = _result(raw.get("course_details"))
    relations = _result(raw.get("relations"), default=[])
    info_book = _result(raw.get("info_and_book"), default={})
    progress = _result(raw.get("course_progress"), default={})
    methods = _result(raw.get("methods"), default=[])
    leaves = _result(raw.get("tch_leaves"), default=[])

    jon_cou_sn = detail.get("jonCouSn") or list_row.get("jonCouSn")
    lcid = raw.get("lcid", DEFAULT_LCID)

    organization = _normalize_organization(detail)
    organization["audience_department"] = normalize_audience_department(
        organization.get("department_name_zh")
    )
    organization["study_level"] = infer_study_level(organization)
    organization["audience_grade"] = infer_audience_grade(organization)
    if department_catalog:
        enrich_organization_department(organization, department_catalog)

    canonical = {
        "schema_version": "fju_outline_v1",
        "source": {
            "system": "fju_outline",
            "hy": raw.get("hy") or detail.get("hy") or list_row.get("hy"),
            "ht": raw.get("ht") or detail.get("ht") or list_row.get("ht"),
            "sco_typ": raw.get("scoTyp", DEFAULT_SCO_TYP),
            "lcid": lcid,
            "jon_cou_sn": jon_cou_sn,
            "fetched_at": raw.get("fetched_at") or now_iso(),
            "source_url": SOURCE_VIEW_URL.format(jon_cou_sn=jon_cou_sn, lcid=lcid),
            "pdf_endpoint": "OutlineFileOutput/CourseOutlinePDF",
            "pdf_params": {"jonCouSn": jon_cou_sn, "lcid": lcid},
        },
        "course": _normalize_course(list_row, detail),
        "organization": organization,
        "teachers": _normalize_teachers(list_row, detail, info_book),
        "class_meetings": _normalize_class_meetings(list_row, detail),
        "outline": {
            "basic_info": detail,
            "literacy": [],
            "core_competencies": [],
            "special_issues": [],
            "sdgs": [],
            "innovation_features": [],
            "learning_objectives": _normalize_learning_objectives(info_book),
            "weekly_progress": _normalize_weekly_progress(progress),
            "teaching_methods": _normalize_methods(methods, m_type=1),
            "assessments": _normalize_methods(methods, m_type=2),
            "materials": _normalize_materials(info_book, progress),
            "learning_norms": info_book.get("norms") or "",
            "notes": info_book.get("other") or "",
            "makeup_classes": leaves if isinstance(leaves, list) else [],
        },
        "raw": raw,
    }

    for relation in relations or []:
        normalized = _normalize_relation(relation)
        bucket = RELATION_BUCKETS.get(relation.get("coreNo"), "core_competencies")
        if bucket in {"core_knowledge", "core_skills_attitudes"}:
            canonical["outline"]["core_competencies"].append(normalized)
        else:
            canonical["outline"][bucket].append(normalized)

    return canonical


def build_document(record: dict[str, Any]) -> dict[str, Any]:
    course = record["course"]
    outline = record["outline"]
    weekly = "\n".join(
        f"第{row.get('week')}週 {row.get('date') or ''} {row.get('topic') or ''} {row.get('unit') or ''}".strip()
        for row in outline.get("weekly_progress", [])
    )
    methods = ", ".join(
        f"{row['name_zh']} {row['percent']}%"
        for row in outline.get("teaching_methods", [])
        if row.get("percent")
    )
    assessments = ", ".join(
        f"{row['name_zh']} {row['percent']}%"
        for row in outline.get("assessments", [])
        if row.get("percent")
    )
    objectives = outline.get("learning_objectives", {})
    sections = {
        "objective": objectives.get("objective") or "",
        "weekly_progress": weekly,
        "materials": "\n".join(
            str(item.get("value") or "") for item in outline.get("materials", [])
        ),
        "methods": methods,
        "assessment": assessments,
        "learning_norms": outline.get("learning_norms") or "",
    }
    full_document = "\n".join(
        part
        for part in (
            f"課程名稱：{course.get('name_zh') or ''}",
            f"英文名稱：{course.get('name_en') or ''}",
            f"課程目標：{sections['objective']}",
            f"授課進度：\n{sections['weekly_progress']}",
            f"教材：\n{sections['materials']}",
            f"教學方法：{sections['methods']}",
            f"學習評量：{sections['assessment']}",
            f"學習規範：{sections['learning_norms']}",
        )
        if part.strip()
    )
    return {
        "course_id": course.get("course_id"),
        "jon_cou_sn": record["source"].get("jon_cou_sn"),
        "title": course.get("name_zh"),
        "title_en": course.get("name_en"),
        "sections": sections,
        "full_document_zh": full_document,
    }


def _result(response: Any, default: Any = None) -> Any:
    if response is None:
        return default
    if isinstance(response, dict) and "result" in response:
        return response["result"]
    return response


def _normalize_course(list_row: dict[str, Any], detail: dict[str, Any]) -> dict[str, Any]:
    jon_cou_sn = detail.get("jonCouSn") or list_row.get("jonCouSn")
    return {
        "course_id": str(jon_cou_sn),
        "jon_cou_sn": jon_cou_sn,
        "ava_no": detail.get("avaNO") or list_row.get("avaNO"),
        "joint_ava_no": list_row.get("jAvaNO"),
        "name_zh": detail.get("couCNa") or list_row.get("couCNa"),
        "name_en": detail.get("couENa") or list_row.get("couENa"),
        "credits": _as_float(detail.get("credit") or list_row.get("credit")),
        "required_elective_code": detail.get("reqSel") or list_row.get("reqSel"),
        "required_elective_name": detail.get("reqSelCNa") or list_row.get("reqSelCNa"),
        "year": detail.get("hy") or list_row.get("hy"),
        "semester": detail.get("ht") or list_row.get("ht"),
        "term": detail.get("term") if detail.get("term") is not None else list_row.get("term"),
        "course_type": "一般學期",
        "is_outline_done": bool(detail.get("isDone", list_row.get("isDone", False))),
        "all_is_done": bool(detail.get("allIsDone", False)),
        "default_is_done": bool(detail.get("defaultIsDone", False)),
        "lcid_is_done": bool(detail.get("lcIdIsDone", False)),
    }


def _normalize_organization(detail: dict[str, Any]) -> dict[str, Any]:
    return {
        "division_code": detail.get("dayNgt"),
        "division_name_zh": detail.get("dayCNa"),
        "division_name_en": detail.get("dayENa"),
        "department_code": detail.get("dptNo"),
        "department_name_zh": detail.get("dptGrdCN"),
        "department_name_en": detail.get("dptGrdEng"),
        "college_code": detail.get("groNo"),
    }


def _normalize_teachers(
    list_row: dict[str, Any], detail: dict[str, Any], info_book: dict[str, Any]
) -> list[dict[str, Any]]:
    teachers = [{
        "teacher_id": detail.get("tchNo") or list_row.get("tchNo"),
        "name_zh": detail.get("tchCNa") or list_row.get("tchCNa"),
        "name_en": detail.get("tchENa") or list_row.get("tchENa"),
        "is_primary": (detail.get("teaMain") or "Y") == "Y",
        "title_zh": detail.get("titleCNa"),
        "title_en": detail.get("titleENa"),
        "employment_type_zh": detail.get("sideCNa"),
        "employment_type_en": detail.get("sideENa"),
        "email": info_book.get("email") or info_book.get("contact"),
        "office": info_book.get("office") or "",
        "course_office_hours": info_book.get("courseOfficeHr") or "",
        "teaching_language_zh": detail.get("teaLangCNa"),
        "material_language_zh": detail.get("teaMaterCNa"),
    }]
    for extra in detail.get("tchList") or []:
        if not isinstance(extra, dict):
            teachers.append({
                "teacher_id": None,
                "name_zh": str(extra),
                "name_en": None,
                "is_primary": False,
                "raw": extra,
            })
            continue
        teachers.append({
            "teacher_id": extra.get("tchNo"),
            "name_zh": extra.get("tchCNa"),
            "name_en": extra.get("tchENa"),
            "is_primary": (extra.get("teaMain") or "N") == "Y",
        })
    return teachers


def _normalize_class_meetings(
    list_row: dict[str, Any], detail: dict[str, Any]
) -> list[dict[str, Any]]:
    seq_source = list_row.get("seqList") or []
    if not seq_source and detail.get("seqList"):
        seq_source = [{"raw": value} for value in detail["seqList"]]
    meetings = []
    for seq in seq_source:
        sections = _split_sections(seq.get("section"))
        meetings.append({
            "weekday": _as_int(seq.get("couWek")),
            "weekday_name": _weekday_name(seq.get("couWek")),
            "sections": sections,
            "section_raw": seq.get("section"),
            "room": _room_code(seq.get("romNO")),
            "room_raw": seq.get("romNO"),
            "week_pattern": seq.get("sda"),
            "raw": seq,
        })
    return meetings


def _normalize_learning_objectives(info_book: dict[str, Any]) -> dict[str, Any]:
    return {
        "objective": info_book.get("obj") or "",
        "prerequisite": info_book.get("preCourse") or "",
        "course_material_summary": info_book.get("cm") or "",
        "textbook": info_book.get("book") or "",
        "references": info_book.get("refBook") or "",
        "teaching_platform_url": info_book.get("tchUrl") or "",
    }


def _normalize_weekly_progress(progress: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for item in progress.get("weeklyCP") or []:
        rows.append({
            "week": item.get("cweek"),
            "date": item.get("dte"),
            "unit": item.get("unit"),
            "topic": item.get("theme"),
            "notes": item.get("other") or "",
            "physical_hours": _as_float(item.get("physicalClassHr")),
            "async_online_hours": _as_float(item.get("asyncOnlineClassHr")),
            "sync_online_hours": _as_float(item.get("syncOnlineClassHr")),
            "materials": item.get("weeklyTeaMater") or [],
            "raw": item,
        })
    return rows


def _normalize_methods(methods: list[dict[str, Any]], *, m_type: int) -> list[dict[str, Any]]:
    rows = []
    for group in methods or []:
        if group.get("mType") != m_type:
            continue
        for item in group.get("methodsDetails") or []:
            rows.append({
                "type": "teaching_method" if m_type == 1 else "assessment",
                "method_sn": item.get("methodSN"),
                "name_zh": item.get("methodName"),
                "name_en": item.get("methodEName"),
                "percent": _as_float(item.get("percent")),
                "is_teacher_set": bool(item.get("isTeaSet", False)),
                "raw": item,
            })
    return rows


def _normalize_materials(
    info_book: dict[str, Any], progress: dict[str, Any]
) -> list[dict[str, Any]]:
    materials = []
    for kind, key in (
        ("course_material_summary", "cm"),
        ("textbook", "book"),
        ("reference_book", "refBook"),
        ("teaching_platform_url", "tchUrl"),
    ):
        value = info_book.get(key)
        if value:
            materials.append({"kind": kind, "value": value})
    for item in progress.get("courseTeaMater") or []:
        materials.append({"kind": "course_teaching_material", "value": item, "raw": item})
    return materials


def _normalize_relation(relation: dict[str, Any]) -> dict[str, Any]:
    value = relation.get("relation")
    return {
        "group": relation.get("coreName"),
        "core_no": relation.get("coreNo"),
        "item_no": relation.get("itemNo"),
        "name": relation.get("itemName"),
        "description": relation.get("itemDesc") or "",
        "relation": value,
        "relation_label": RELATION_LABELS.get(value, str(value)),
        "note": relation.get("note") or "",
        "raw": relation,
    }


def _as_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _split_sections(value: Any) -> list[str]:
    if not value:
        return []
    return [part.strip() for part in str(value).split(",") if part.strip()]


def _room_code(value: Any) -> str | None:
    if not value:
        return None
    return str(value).split("-", 1)[0]


def _weekday_name(value: Any) -> str | None:
    names = {
        "1": "Monday",
        "2": "Tuesday",
        "3": "Wednesday",
        "4": "Thursday",
        "5": "Friday",
        "6": "Saturday",
        "7": "Sunday",
    }
    return names.get(str(value))
