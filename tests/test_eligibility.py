from __future__ import annotations

from fju_outline.eligibility import evaluate_eligibility, extract_eligibility_rules


def _record(*, reject=None, note="", prerequisite="", department="資訊工程學系", division=""):
    return {
        "organization": {"department_name_zh": department, "division_name_zh": division},
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
    assert result["pending"][0]["value"] == {"prerequisite": "需要 Python 基礎"}


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


def test_extracts_master_study_level_and_evaluates_student_level():
    rules = extract_eligibility_rules(_record(department="資工碩一", division="研究所"))
    assert [rule["kind"] for rule in rules] == ["study_level_only"]
    assert rules[0]["value"] == {"study_level": "master"}
    assert evaluate_eligibility(rules, study_level="undergraduate")["status"] == "blocked_confirmed"
    assert evaluate_eligibility(rules, study_level="master")["status"] == "eligible_confirmed"


def test_extracts_doctoral_study_level_from_department_label():
    rules = extract_eligibility_rules(_record(department="生科博一", division="研究所"))
    assert rules[0]["value"]["study_level"] == "doctoral"


def test_extracts_high_grade_audience_rule_from_department_label():
    rules = extract_eligibility_rules(_record(department="資訊工程學系三年級", division="日間部"))
    assert rules[0]["kind"] == "audience_grade_only"
    assert evaluate_eligibility(rules, grade=2)["status"] == "blocked_confirmed"
    assert evaluate_eligibility(rules, grade=3)["status"] == "eligible_confirmed"
