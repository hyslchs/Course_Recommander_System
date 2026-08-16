import asyncio

from fju_outline.departments import (
    department_names_match,
    fetch_official_department_catalog,
    match_official_department,
)


CATALOG = {
    "departments": [
        {
            "division_code": "D",
            "code": "0E",
            "label": "0E-企業管理學系",
            "name_zh": "企業管理學系",
            "department_type": "department",
        },
        {
            "division_code": "D",
            "code": "K14",
            "label": "K14-國際企業管理學程",
            "name_zh": "國際企業管理學程",
            "department_type": "program",
        },
        {
            "division_code": "D",
            "code": "K36",
            "label": "K36-企業財稅管理學分學程",
            "name_zh": "企業財稅管理學分學程",
            "department_type": "credit_program",
        },
        {
            "division_code": "D",
            "code": "0E",
            "label": "0E-企業管理學系",
            "name_zh": "企業管理學系",
            "department_type": "department",
        },
        {
            "division_code": "D",
            "code": "K14",
            "label": "K14-國際企業管理學程",
            "name_zh": "國際企業管理學程",
            "department_type": "program",
        },
        {
            "division_code": "D",
            "code": "K36",
            "label": "K36-企業財稅管理學分學程",
            "name_zh": "企業財稅管理學分學程",
            "department_type": "credit_program",
        },
        {
            "division_code": "D",
            "code": "10",
            "label": "10-圖書資訊學系",
            "name_zh": "圖書資訊學系",
        },
        {
            "division_code": "D",
            "code": "51",
            "label": "51-資訊工程學系",
            "name_zh": "資訊工程學系",
        },
        {
            "division_code": "D",
            "code": "74",
            "label": "74-資訊管理學系",
            "name_zh": "資訊管理學系",
        },
        {
            "division_code": "C",
            "code": "01",
            "label": "01-中國文學系",
            "name_zh": "中國文學系",
        },
        {
            "division_code": "C",
            "code": "Q3",
            "label": "Q3-中國文學系培力專班",
            "name_zh": "中國文學系培力專班",
        },
    ]
}


def test_matches_course_outline_abbreviation_to_official_name():
    match = match_official_department(
        {
            "division_code": "D",
            "department_code": None,
            "department_name_zh": "圖資一",
        },
        CATALOG,
    )

    assert match["status"] == "matched"
    assert match["method"] == "abbreviation"
    assert match["official_department_code"] == "10"
    assert match["official_department_name_zh"] == "圖書資訊學系"


def test_uses_official_code_before_abbreviation():
    match = match_official_department(
        {
            "division_code": "D",
            "department_code": "51",
            "department_name_zh": "資工三",
        },
        CATALOG,
    )

    assert match["method"] == "official_code"
    assert match["official_department_name_zh"] == "資訊工程學系"


def test_does_not_match_unrelated_abbreviations():
    assert not department_names_match("資工", "資訊管理學系")
    assert not department_names_match("企業管理學系", "國際企業管理學程")
    assert not department_names_match("企業管理學系", "企業財稅管理學分學程")


def test_keeps_department_program_and_credit_program_as_distinct_candidates():
    match = match_official_department(
        {
            "division_code": "D",
            "department_code": None,
            "department_name_zh": "企管四",
        },
        CATALOG,
    )

    assert match["status"] == "ambiguous"
    assert [item["department_type"] for item in match["candidate_details"][:3]] == [
        "department",
        "program",
        "credit_program",
    ]
    assert not department_names_match("企業管理學系", "國際企業管理學程")
    assert not department_names_match("企業管理學系", "企業財稅管理學分學程")


def test_prefers_parent_department_over_special_class():
    match = match_official_department(
        {
            "division_code": "C",
            "department_code": None,
            "department_name_zh": "中文系",
        },
        CATALOG,
    )

    assert match["status"] == "matched"
    assert match["official_department_code"] == "01"


def test_fetches_each_division_with_official_api_parameters():
    class FakeClient:
        async def get_json(self, endpoint, **params):
            if endpoint == "Common/VwDayNgtRefDDL":
                return type("Response", (), {"data": {"result": {"result": [
                    {"value": "D", "label": "D-日間部"},
                    {"value": "G", "label": "G-研究所"},
                ]}}})()
            assert endpoint == "Common/DptByDayNgtAndGroDDL"
            assert params["HY"] == 115
            assert params["lcid"] == 1028
            return type("Response", (), {"data": {"result": {"result": [
                {"value": params["dayNgt"], "label": f"{params['dayNgt']}-測試系所"},
            ]}}})()

    catalog = asyncio.run(fetch_official_department_catalog(FakeClient(), hy=115, lcid=1028))

    assert [row["code"] for row in catalog["divisions"]] == ["D", "G"]
    assert len(catalog["departments"]) == 2
