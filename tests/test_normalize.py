from __future__ import annotations

from fju_outline.normalize import build_document, normalize_course_record


def test_normalize_course_record_keeps_raw_and_core_sections():
    raw = {
        "hy": 115,
        "ht": 1,
        "scoTyp": 100,
        "lcid": 1028,
        "fetched_at": "2026-06-27T12:00:00+08:00",
        "list_row": {
            "hy": 115,
            "ht": 1,
            "jonCouSn": 753926,
            "avaNO": "C010001466",
            "couCNa": "老子",
            "couENa": "Lao Tze",
            "tchNo": "089939",
            "tchCNa": "邱文才",
            "credit": 2.0,
            "reqSel": "S",
            "reqSelCNa": "選修",
            "seqList": [{"sda": "A", "couWek": "1", "romNO": "LI105-一般教室", "section": "D7,D8"}],
        },
        "course_details": {
            "statusCode": 200,
            "result": {
                "jonCouSn": 753926,
                "hy": 115,
                "ht": 1,
                "avaNO": "C010001466",
                "couCNa": "老子",
                "couENa": "Lao Tze",
                "tchNo": "089939",
                "tchCNa": "邱文才",
                "isDone": True,
                "dayNgt": "C",
                "dayCNa": "進修部",
                "dptGrdCN": "中文系",
            },
        },
        "relations": {
            "statusCode": 200,
            "result": [
                {"coreNo": 1, "coreName": "基本素養", "itemNo": 1, "itemName": "中文", "relation": 3},
                {"coreNo": 5, "coreName": "專門議題", "itemNo": 3, "itemName": "生命教育", "relation": 1},
                {"coreNo": 10, "coreName": "永續發展目標", "itemNo": 4, "itemName": "優質教育", "relation": 3},
            ],
        },
        "info_and_book": {
            "statusCode": 200,
            "result": {"obj": "認識老子學說", "book": "老子王弼注", "norms": "上課請關機。"},
        },
        "course_progress": {
            "statusCode": 200,
            "result": {"weeklyCP": [{"cweek": 1, "dte": "09/18", "theme": "課程說明"}]},
        },
        "methods": {
            "statusCode": 200,
            "result": [
                {"mType": 1, "methodsDetails": [{"methodSN": 1, "methodName": "講述", "percent": 50}]},
                {"mType": 2, "methodsDetails": [{"methodSN": 12, "methodName": "心得或作業撰寫", "percent": 50}]},
            ],
        },
    }

    record = normalize_course_record(raw)

    assert record["course"]["course_id"] == "753926"
    assert record["organization"]["department_name_zh"] == "中文系"
    assert record["class_meetings"][0]["sections"] == ["D7", "D8"]
    assert record["outline"]["literacy"][0]["relation_label"] == "直接相關"
    assert record["outline"]["special_issues"][0]["name"] == "生命教育"
    assert record["outline"]["sdgs"][0]["name"] == "優質教育"
    assert record["outline"]["weekly_progress"][0]["topic"] == "課程說明"
    assert record["raw"] == raw


def test_build_document_contains_recommendation_text_sections():
    record = normalize_course_record({
        "list_row": {"jonCouSn": 1, "couCNa": "課程A"},
        "course_details": {"result": {"jonCouSn": 1, "couCNa": "課程A"}},
        "relations": {"result": []},
        "info_and_book": {"result": {"obj": "學習目標", "book": "教材", "norms": "規範"}},
        "course_progress": {"result": {"weeklyCP": [{"cweek": 1, "theme": "主題"}]}},
        "methods": {"result": []},
    })

    document = build_document(record)

    assert document["course_id"] == "1"
    assert "課程名稱：課程A" in document["full_document_zh"]
    assert "學習目標" in document["sections"]["objective"]
