from __future__ import annotations

from fju_outline.eligibility import evaluate_eligibility, extract_eligibility_rules


def _record(*, reject=None, note="", prerequisite=""):
    return {
        "organization": {"department_name_zh": "資訊工程學系三年級"},
        "outline": {
            "basic_info": {"rejList": reject or [], "avaNote": note},
            "learning_objectives": {"prerequisite": prerequisite},
        },
    }


def test_extracts_formal_prerequisite_and_minimum_grade():
    rules = extract_eligibility_rules(
        _record(reject=["資料結構(3.00)"], note="三年級以上可選修")
    )
    assert [rule["kind"] for rule in rules] == ["course_prerequisite", "minimum_grade"]
    assert rules[0]["value"] == {"course_name": "資料結構", "credits": 3.0}
    assert rules[1]["value"]["grade"] == 3


def test_unknown_prerequisite_is_never_marked_confirmed():
    rules = extract_eligibility_rules(_record(prerequisite="需要 Python 基礎"))
    result = evaluate_eligibility(rules, grade=4)
    assert result["status"] == "needs_confirmation"
    assert result["pending"][0]["evidence"] == "需要 Python 基礎"


def test_formal_prerequisite_blocks_until_completed():
    rules = extract_eligibility_rules(_record(reject=["資料結構(3.00)"]))
    assert evaluate_eligibility(rules, completed_course_names=set())["status"] == "blocked_confirmed"
    assert (
        evaluate_eligibility(rules, completed_course_names={"資料結構"})["status"]
        == "eligible_confirmed"
    )


def test_offering_department_is_not_a_restriction():
    assert extract_eligibility_rules(_record()) == []
    assert evaluate_eligibility([], department="其他系")["status"] == "no_known_restriction"
