from __future__ import annotations

import re
from typing import Any


EligibilityRule = dict[str, Any]

_EMPTY_TEXT = {"", "無", "無。", "無.", "none", "none.", "n/a", "na"}
_GRADE_DIGITS = {
    "一": 1,
    "二": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "1": 1,
    "2": 2,
    "3": 3,
    "4": 4,
    "5": 5,
    "6": 6,
    "7": 7,
}
_GRADE_MIN_RE = re.compile(r"([一二三四五六七1-7])年級(?:以上|含以上|及以上)可?(?:選|修)")
_GRADE_ONLY_RE = re.compile(r"(?:僅限|限)([一二三四五六七1-7])年級")
_DIVISION_RE = re.compile(r"(?:僅限|限)(日間部|進修部|研究所|二年制)")
_DEPARTMENT_RE = re.compile(r"(?:僅限|限)([^，。、；\s]{2,20}(?:系|所))(?:學生|同學)?")
_CONSTRAINT_HINT_RE = re.compile(
    r"(?:限|不得|不可|不開放|擋修|先修|修畢|修過|加簽|同意|資格|年級|本系|外系|跨部)"
)


def extract_eligibility_rules(record: dict[str, Any]) -> list[EligibilityRule]:
    """Extract only high-confidence rules and preserve uncertain evidence.

    The offering department/grade is intentionally not interpreted as an
    enrollment restriction.
    """

    outline = record.get("outline", {})
    basic = outline.get("basic_info") or {}
    objectives = outline.get("learning_objectives") or {}
    organization = record.get("organization") or {}
    rules: list[EligibilityRule] = []

    for prerequisite in basic.get("rejList") or []:
        evidence = _as_text(prerequisite)
        if not evidence:
            continue
        name, credits = _split_prerequisite(evidence)
        rules.append(
            _rule(
                "course_prerequisite",
                "formal_prerequisite",
                f"須先修畢「{name}」",
                "outline.basic_info.rejList",
                evidence,
                {"course_name": name, "credits": credits},
            )
        )

    ava_note = _as_text(basic.get("avaNote"))
    if ava_note:
        rules.extend(
            _parse_constraint_text(
                ava_note,
                source_field="outline.basic_info.avaNote",
                department=organization.get("department_name_zh") or "",
            )
        )

    prerequisite_text = _as_text(objectives.get("prerequisite"))
    if prerequisite_text and prerequisite_text.strip().lower() not in _EMPTY_TEXT:
        rules.append(
            _rule(
                "advisory_prerequisite",
                "manual_confirmation",
                "課綱列有先備知識，請自行確認是否符合",
                "outline.learning_objectives.prerequisite",
                prerequisite_text,
            )
        )

    return _deduplicate(rules)


def base_eligibility_status(rules: list[EligibilityRule]) -> str:
    if any(rule["kind"] in {"advisory_prerequisite", "manual_confirmation"} for rule in rules):
        return "needs_confirmation"
    return "no_known_restriction"


def evaluate_eligibility(
    rules: list[EligibilityRule],
    *,
    grade: int | None = None,
    department: str = "",
    division: str = "",
    completed_course_names: set[str] | None = None,
) -> dict[str, Any]:
    completed = {name.strip() for name in (completed_course_names or set()) if name.strip()}
    blocked: list[EligibilityRule] = []
    pending: list[EligibilityRule] = []
    satisfied: list[EligibilityRule] = []

    for rule in rules:
        kind = rule["kind"]
        value = rule.get("value") or {}
        if kind == "course_prerequisite":
            (satisfied if value.get("course_name") in completed else blocked).append(rule)
        elif kind == "minimum_grade":
            if grade is None:
                pending.append(rule)
            else:
                (satisfied if grade >= int(value["grade"]) else blocked).append(rule)
        elif kind == "exact_grade":
            if grade is None:
                pending.append(rule)
            else:
                (satisfied if grade == int(value["grade"]) else blocked).append(rule)
        elif kind == "division_only":
            if not division:
                pending.append(rule)
            else:
                (satisfied if division == value.get("division") else blocked).append(rule)
        elif kind == "department_only":
            if not department:
                pending.append(rule)
            else:
                expected = str(value.get("department") or "")
                (satisfied if expected in department or department in expected else blocked).append(rule)
        else:
            pending.append(rule)

    if blocked:
        status = "blocked_confirmed"
    elif pending:
        status = "needs_confirmation"
    elif satisfied:
        status = "eligible_confirmed"
    else:
        status = "no_known_restriction"
    return {"status": status, "blocked": blocked, "pending": pending, "satisfied": satisfied}


def _parse_constraint_text(text: str, *, source_field: str, department: str) -> list[EligibilityRule]:
    rules: list[EligibilityRule] = []
    consumed = False
    for match in _GRADE_MIN_RE.finditer(text):
        grade = _GRADE_DIGITS[match.group(1)]
        rules.append(
            _rule(
                "minimum_grade",
                "minimum_grade",
                f"限 {grade} 年級以上修習",
                source_field,
                match.group(0),
                {"grade": grade},
            )
        )
        consumed = True
    for match in _GRADE_ONLY_RE.finditer(text):
        grade = _GRADE_DIGITS[match.group(1)]
        rules.append(
            _rule(
                "exact_grade",
                "exact_grade",
                f"限 {grade} 年級修習",
                source_field,
                match.group(0),
                {"grade": grade},
            )
        )
        consumed = True
    for match in _DIVISION_RE.finditer(text):
        division = match.group(1)
        rules.append(
            _rule(
                "division_only",
                "division_only",
                f"限{division}學生修習",
                source_field,
                match.group(0),
                {"division": division},
            )
        )
        consumed = True
    for match in _DEPARTMENT_RE.finditer(text):
        expected = match.group(1)
        if expected == "本系" and department:
            expected = department
        rules.append(
            _rule(
                "department_only",
                "department_only",
                f"限{expected}學生修習",
                source_field,
                match.group(0),
                {"department": expected},
            )
        )
        consumed = True
    if _CONSTRAINT_HINT_RE.search(text) and not consumed:
        rules.append(
            _rule(
                "manual_confirmation",
                "manual_confirmation",
                "加選備註可能包含限制，請查看原文",
                source_field,
                text,
            )
        )
    return rules


def _rule(
    kind: str,
    reason_code: str,
    message: str,
    source_field: str,
    evidence: str,
    value: dict[str, Any] | None = None,
) -> EligibilityRule:
    return {
        "kind": kind,
        "reason_code": reason_code,
        "message": message,
        "source_field": source_field,
        "evidence": evidence,
        "value": value or {},
    }


def _split_prerequisite(value: str) -> tuple[str, float | None]:
    match = re.match(r"^(.*?)(?:\((\d+(?:\.\d+)?)\))?$", value.strip())
    if not match:
        return value.strip(), None
    return match.group(1).strip(), float(match.group(2)) if match.group(2) else None


def _as_text(value: Any) -> str:
    return str(value or "").strip()


def _deduplicate(rules: list[EligibilityRule]) -> list[EligibilityRule]:
    seen: set[tuple[str, str, str]] = set()
    result = []
    for rule in rules:
        key = (rule["kind"], rule["source_field"], rule["evidence"])
        if key not in seen:
            result.append(rule)
            seen.add(key)
    return result
