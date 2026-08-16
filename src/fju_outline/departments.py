from __future__ import annotations

import re
import unicodedata
from datetime import datetime, timezone
from typing import Any, Iterable

from .client import FjuOutlineClient
from .config import BASE_URL


DIVISION_ENDPOINT = "Common/VwDayNgtRefDDL"
DEPARTMENT_ENDPOINT = "Common/DptByDayNgtAndGroDDL"
EXCLUDED_DIVISION_CODES: set[str] = set()

_GRADE_SUFFIX_RE = re.compile(
    r"[一二三四五六七1-7](?:年級|[甲乙丙丁戊己庚辛壬癸愛智仁勇忠孝信義和平]+)?$"
)
_CODE_RE = re.compile(r"^[A-Za-z0-9]{1,5}$")
_PUNCTUATION_RE = re.compile(r"[\s\-‐‑‒–—_·・/\\（）()、，,。．.:：；;]+")
_DEPARTMENT_SUFFIXES = (
    "博士學位學程",
    "碩士學位學程",
    "學士學位學程",
    "學位學程",
    "研究所",
    "碩士班",
    "博士班",
    "在職專班",
    "學系",
    "學院",
    "學程",
    "系所",
    "系",
    "所",
    "班",
)


async def fetch_official_department_catalog(
    client: FjuOutlineClient,
    *,
    hy: int,
    lcid: int,
) -> dict[str, Any]:
    """Fetch the same department options used by the official SPA.

    The visible ``系所`` select is populated by the official JSON API after a
    ``部別`` is selected.  Keeping the response in a small versioned artifact
    makes the mapping reproducible without requiring browser automation.
    """

    division_response = await client.get_json(DIVISION_ENDPOINT)
    divisions = _ddl_items(division_response.data)
    division_rows: list[dict[str, Any]] = []
    for division in divisions:
        division_code = _text(division.get("value"))
        if not division_code or division_code in EXCLUDED_DIVISION_CODES:
            continue
        department_response = await client.get_json(
            DEPARTMENT_ENDPOINT,
            HY=hy,
            dayNgt=division_code,
            lcid=lcid,
        )
        departments = [
            {
                "code": _text(item.get("value")),
                "label": _text(item.get("label")),
                "name_zh": _department_name(item),
                "department_type": _department_type(_department_name(item)),
            }
            for item in _ddl_items(department_response.data)
            if _text(item.get("value")) and _text(item.get("label"))
        ]
        division_rows.append(
            {
                "code": division_code,
                "label": _text(division.get("label")),
                "name_zh": _division_name(division),
                "departments": departments,
            }
        )

    flattened = [
        {
            "division_code": division["code"],
            "division_name_zh": division["name_zh"],
            **department,
        }
        for division in division_rows
        for department in division["departments"]
    ]
    return {
        "schema_version": "fju_department_catalog_v2",
        "fetched_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "source": {
            "base_url": BASE_URL,
            "division_endpoint": DIVISION_ENDPOINT,
            "department_endpoint": DEPARTMENT_ENDPOINT,
            "parameters": {"HY": hy, "lcid": lcid},
        },
        "hy": hy,
        "lcid": lcid,
        "divisions": division_rows,
        "departments": flattened,
    }


def enrich_organization_department(
    organization: dict[str, Any],
    department_catalog: dict[str, Any] | Iterable[dict[str, Any]],
) -> dict[str, Any]:
    """Attach an official department identity to a normalized organization."""

    match = match_official_department(organization, department_catalog)
    organization["department_match"] = match
    if match["status"] != "matched":
        return organization
    organization["official_department_code"] = match["official_department_code"]
    organization["official_department_name_zh"] = match["official_department_name_zh"]
    organization["official_department_label"] = match["official_department_label"]
    organization["official_department_type"] = match["official_department_type"]
    return organization


def match_official_department(
    organization: dict[str, Any],
    department_catalog: dict[str, Any] | Iterable[dict[str, Any]],
) -> dict[str, Any]:
    """Match a course-outline organization to one official dropdown option.

    Course details do not consistently return ``dptNo``.  The matcher first
    uses that stable code when present, then exact normalized names, and only
    finally uses a conservative Chinese abbreviation/subsequence match.  An
    ambiguous match is deliberately left unresolved instead of guessing.
    """

    departments = list(_flatten_departments(department_catalog))
    division_code = _text(organization.get("division_code"))
    scoped = [
        item for item in departments
        if not division_code or _text(item.get("division_code")) == division_code
    ]
    course_labels = _course_labels(organization)
    scoped = _filter_by_study_level(scoped, course_labels, division_code)
    code = _text(organization.get("department_code"))
    if code:
        code_matches = [item for item in scoped if _codes_equal(code, item.get("code"))]
        if len(code_matches) == 1:
            return _matched(code_matches[0], method="official_code", confidence=1.0)

    course_forms = {_compact_department_label(label) for label in course_labels if label}
    course_forms.discard("")
    if not course_forms:
        return _unmatched()

    exact_matches = [
        item for item in scoped
        if _compact_department_label(item.get("name_zh")) in course_forms
    ]
    if len(exact_matches) == 1:
        return _matched(exact_matches[0], method="normalized_name", confidence=0.98)
    if len(exact_matches) > 1:
        return _ambiguous(exact_matches)

    candidates = []
    for item in scoped:
        official_form = _compact_department_label(item.get("name_zh"))
        if not official_form:
            continue
        if any(
            len(form) >= 2 and _is_subsequence(form, official_form)
            for form in course_forms
        ):
            candidates.append(item)
    preferred_candidates = _prefer_parent_candidate(candidates)
    if len(preferred_candidates) == 1:
        return _matched(preferred_candidates[0], method="abbreviation", confidence=0.82)
    if candidates:
        return _ambiguous(candidates)
    return _unmatched()


def department_names_match(left: Any, right: Any) -> bool:
    """Compare full department labels and common FJU abbreviations safely."""

    left_type = _department_type(left)
    right_type = _department_type(right)
    if left_type and right_type and left_type != right_type:
        return False
    left_form = _compact_department_label(left)
    right_form = _compact_department_label(right)
    if not left_form or not right_form:
        return False
    if left_form == right_form:
        return True
    shorter, longer = sorted((left_form, right_form), key=len)
    return len(shorter) >= 2 and _is_subsequence(shorter, longer)


def _flatten_departments(
    catalog: dict[str, Any] | Iterable[dict[str, Any]],
) -> Iterable[dict[str, Any]]:
    if isinstance(catalog, dict):
        if isinstance(catalog.get("departments"), list):
            return catalog["departments"]
        divisions = catalog.get("divisions") or []
        return [
            {
                "division_code": division.get("code"),
                "division_name_zh": division.get("name_zh"),
                **department,
            }
            for division in divisions
            for department in division.get("departments") or []
        ]
    return catalog


def _ddl_items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    result = payload.get("result") if isinstance(payload, dict) else None
    if isinstance(result, dict):
        result = result.get("result")
    return [item for item in result or [] if isinstance(item, dict)]


def _department_name(item: dict[str, Any]) -> str:
    label = _text(item.get("label"))
    value = _text(item.get("value"))
    if label.startswith(f"{value}-"):
        return label[len(value) + 1 :]
    _, separator, name = label.partition("-")
    return name.strip() if separator else label


def _department_type(value: Any) -> str:
    text = _text(value)
    if "微學程" in text:
        return "micro_program"
    if "學分學程" in text:
        return "credit_program"
    if "學位學程" in text:
        return "degree_program"
    if "學程" in text:
        return "program"
    if "學院" in text:
        return "college"
    if "研究所" in text:
        return "graduate_institute"
    if "學系" in text or text.endswith("系"):
        return "department"
    return ""


def _division_name(item: dict[str, Any]) -> str:
    label = _text(item.get("label"))
    code = _text(item.get("value"))
    if label.startswith(f"{code}-"):
        return label[len(code) + 1 :]
    _, separator, name = label.partition("-")
    return name.strip() if separator else label


def _course_labels(organization: dict[str, Any]) -> list[str]:
    labels = [
        _text(organization.get("audience_department")),
        _text(organization.get("department_name_zh")),
    ]
    return list(dict.fromkeys(label for label in labels if label))


def _compact_department_label(value: Any) -> str:
    text = unicodedata.normalize("NFKC", _text(value))
    text = _GRADE_SUFFIX_RE.sub("", text)
    text = re.sub(r"(?:博士|碩士|碩職|碩|博)(?:班)?$", "", text)
    text = _PUNCTUATION_RE.sub("", text)
    changed = True
    while changed and text:
        changed = False
        if text.endswith(("化學系", "數學系")):
            text = text[:-1]
            changed = True
            continue
        for suffix in _DEPARTMENT_SUFFIXES:
            if text.endswith(suffix):
                text = text[: -len(suffix)]
                changed = True
                break
    return text


def _filter_by_study_level(
    items: list[dict[str, Any]],
    course_labels: list[str],
    division_code: str,
) -> list[dict[str, Any]]:
    if division_code != "G":
        return items
    joined = "".join(course_labels)
    if "博" in joined or "博士" in joined:
        filtered = [item for item in items if "博士" in _text(item.get("name_zh"))]
    elif "碩職" in joined:
        filtered = [item for item in items if "在職" in _text(item.get("name_zh"))]
    elif "碩" in joined or "碩士" in joined:
        filtered = [item for item in items if "碩士" in _text(item.get("name_zh"))]
    else:
        return items
    return filtered or items


def _is_subsequence(shorter: str, longer: str) -> bool:
    position = 0
    for character in longer:
        if position < len(shorter) and shorter[position] == character:
            position += 1
    return position == len(shorter)


def _prefer_parent_candidate(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Prefer a base department when another option is its special class."""

    if len(items) < 2:
        return items
    forms = {id(item): _compact_department_label(item.get("name_zh")) for item in items}
    shortest = min(forms.values(), key=len)
    if sum(form == shortest for form in forms.values()) != 1:
        return items
    if all(form == shortest or form.startswith(shortest) for form in forms.values()):
        return [item for item in items if forms[id(item)] == shortest]
    return items


def _codes_equal(left: Any, right: Any) -> bool:
    left_text = _text(left).upper()
    right_text = _text(right).upper()
    if left_text == right_text:
        return True
    if left_text.isdigit() and right_text.isdigit():
        return int(left_text) == int(right_text)
    return False


def _matched(item: dict[str, Any], *, method: str, confidence: float) -> dict[str, Any]:
    return {
        "status": "matched",
        "method": method,
        "confidence": confidence,
        "official_department_code": item.get("code"),
        "official_department_name_zh": item.get("name_zh"),
        "official_department_label": item.get("label"),
        "official_department_type": item.get("department_type") or _department_type(item.get("name_zh")),
        "candidate_codes": [item.get("code")],
        "candidate_details": [_candidate_detail(item)],
    }


def _ambiguous(items: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "status": "ambiguous",
        "method": "abbreviation",
        "confidence": 0.0,
        "candidate_codes": [item.get("code") for item in items],
        "candidate_details": [_candidate_detail(item) for item in items],
    }


def _unmatched() -> dict[str, Any]:
    return {
        "status": "unmatched",
        "method": "none",
        "confidence": 0.0,
        "candidate_codes": [],
        "candidate_details": [],
    }


def _candidate_detail(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "division_code": item.get("division_code"),
        "code": item.get("code"),
        "label": item.get("label"),
        "name_zh": item.get("name_zh"),
        "department_type": item.get("department_type") or _department_type(item.get("name_zh")),
    }


def _text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()
