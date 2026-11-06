# tests/booking/test_hospital.py — hospital features: departments, lab, beds, reports, queue, alerts
from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from receptionist.config import BusinessConfig
from receptionist.integrations.clinic_settings import apply_settings
from tests.booking.test_doctors import _call, _receptionist

IST = ZoneInfo("Asia/Kolkata")
TODAY = datetime.now(IST).strftime("%Y-%m-%d")

HOSPITAL = {
    "clinicName": "CityCare Hospital",
    "doctors": [
        {"name": "Dr. Sen", "specialty": "General physician", "department": "General Medicine", "room": "12",
         "leaveDates": [TODAY], "substitute": "Dr. Roy"},
        {"name": "Dr. Bose", "specialty": "Orthopaedic surgeon", "department": "Orthopaedics", "room": "4"},
    ],
    "departments": [{"name": "Orthopaedics", "description": "Bones and joints", "location": "1st floor"}],
    "emergency": {"phone": "033 4000 1111", "ambulancePhone": "98300 00000"},
    "visitingHours": "4 PM to 7 PM daily",
    "insuranceInfo": "Cashless with Star Health and HDFC Ergo.",
    "beds": [{"ward": "ICU", "available": 2, "total": 10}, {"ward": "General", "available": "", "total": 40}],
    "bedsUpdatedAt": "2026-10-29T10:00:00Z",
    "lab": {"name": "Diagnostic Lab", "bookable": True, "slotMinutes": 10,
            "tests": [{"name": "Fasting blood sugar", "price": "₹150", "prep": "10 hours fasting", "reportTime": "same day"}],
            "packages": [{"name": "Full body check-up", "price": "₹1999", "includes": "CBC, lipid, LFT, KFT"}]},
}


def test_hospital_settings_applied(v2_yaml):
    cfg = apply_settings(BusinessConfig.from_yaml_string(v2_yaml), HOSPITAL)
    h = cfg.hospital
    assert h.emergency_phone == "033 4000 1111" and h.ambulance_phone == "98300 00000"
    assert h.beds[0].available == 2 and h.beds[1].available is None
    assert [d.name for d in cfg.doctors] == ["Dr. Sen", "Dr. Bose", "Diagnostic Lab"]
    assert cfg.doctors[0].substitute == "Dr. Roy" and cfg.doctors[1].room == "4"
    assert cfg.doctors[2].slot_minutes == 10


def test_lab_not_bookable_unless_enabled(v2_yaml):
    data = {**HOSPITAL, "lab": {**HOSPITAL["lab"], "bookable": False}}
    cfg = apply_settings(BusinessConfig.from_yaml_string(v2_yaml), data)
    assert "Diagnostic Lab" not in [d.name for d in cfg.doctors]


def test_no_hospital_section_when_empty(v2_yaml):
    cfg = apply_settings(BusinessConfig.from_yaml_string(v2_yaml), {"doctors": [{"name": "Dr. Sen"}]})
    assert cfg.hospital is None


def test_prompt_has_hospital_info(tmp_path, v2_yaml, monkeypatch):
    from receptionist.prompts import build_system_prompt
    monkeypatch.setenv("DASHBOARD_WEBHOOK_URL", "http://localhost:5000/api/webhooks/agent")
    raw, _ = _receptionist(tmp_path, v2_yaml)
    raw = raw.config
    raw = raw.model_copy(update={"business": raw.business.model_copy(update={"type": "hospital", "timezone": "Asia/Kolkata"})})
    p = build_system_prompt(apply_settings(raw, HOSPITAL))
    for text in ("033 4000 1111", "98300 00000", "4 PM to 7 PM", "ICU: 2 free of 10", "Star Health",
                 "Fasting blood sugar", "10 hours fasting", "Full body check-up", "ON LEAVE TODAY (covering: Dr. Roy)",
                 "room 4", "Orthopaedics:", "doctor=\"Diagnostic Lab\"", "check_report_status", "check_opd_queue", "CANNOT reserve"):
        assert text in p, text


def test_hospital_tools_only_with_dashboard(tmp_path, v2_yaml, monkeypatch):
    from receptionist.agent import _active_tools, _tool_display_names
    r, _ = _receptionist(tmp_path, v2_yaml)
    monkeypatch.delenv("DASHBOARD_WEBHOOK_URL", raising=False)
    assert not {"check_report_status", "check_opd_queue"} & set(_tool_display_names(_active_tools(r)))
    monkeypatch.setenv("DASHBOARD_WEBHOOK_URL", "http://x/api/webhooks/agent")
    assert {"check_report_status", "check_opd_queue"} <= set(_tool_display_names(_active_tools(r)))


@pytest.mark.asyncio
async def test_report_status_tool(tmp_path, v2_yaml, monkeypatch):
    import receptionist.integrations.dashboard as dash
    r, _ = _receptionist(tmp_path, v2_yaml)

    async def fake(phone, rid=None):
        assert phone == "9830012345"
        return {"reports": [{"test": "CBC", "date": "28 Oct", "status": "ready"},
                            {"test": "MRI knee", "date": "29 Oct", "status": "processing", "expected": "30 Oct"}],
                "collect": "Lab counter, ground floor, 8 AM - 8 PM"}
    monkeypatch.setattr(dash, "fetch_report_status", fake)
    out = await _call(r.check_report_status, None, "9830012345")
    assert "CBC (28 Oct): READY" in out and "still being processed, expected 30 Oct" in out
    assert "Never read out" in out

    async def none(phone, rid=None):
        return {"reports": []}
    monkeypatch.setattr(dash, "fetch_report_status", none)
    assert "No reports found" in await _call(r.check_report_status, None, "1")


@pytest.mark.asyncio
async def test_queue_tool(tmp_path, v2_yaml, monkeypatch):
    import receptionist.integrations.dashboard as dash
    r, _ = _receptionist(tmp_path, v2_yaml)

    async def fake():
        return {"items": [{"doctor": "Dr. Sen", "nowServing": 7, "waiting": 3}, {"doctor": "Dr. Das", "nowServing": 0}]}
    monkeypatch.setattr(dash, "fetch_queue", fake)
    out = await _call(r.check_opd_queue, None, "sen")
    assert "Dr. Sen: now serving token 7, 3 waiting" in out and "Dr. Das" not in out


@pytest.mark.asyncio
async def test_emergency_alert_sent_once_per_keyword(tmp_path, v2_yaml, monkeypatch):
    import asyncio
    import receptionist.integrations.dashboard as dash
    r, _ = _receptionist(tmp_path, v2_yaml)
    r.lifecycle.urgent_keywords = {"chest pain"}
    r.lifecycle.metadata.caller_phone = None
    sent = []

    async def fake(call_id, **kw):
        sent.append(kw)
    monkeypatch.setattr(dash, "post_emergency_alert", fake)
    monkeypatch.setenv("DASHBOARD_WEBHOOK_URL", "http://x/api/webhooks/agent")
    r._alert_staff(["chest pain"]); r._alert_staff(["chest pain"])
    r._alert_staff((), report={"symptoms": "chest pain"})
    await asyncio.sleep(0)
    assert len(sent) == 2 and sent[1]["report"]["symptoms"] == "chest pain"
