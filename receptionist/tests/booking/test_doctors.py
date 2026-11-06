# tests/booking/test_doctors.py — doctor-wise booking, OPD tokens, leave, live settings
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock
from zoneinfo import ZoneInfo

import re

import pytest

from receptionist.booking.booking import (
    doctor_busy_intervals, leave_intervals, next_token, normalize_doctor,
)
from receptionist.config import (
    BusinessConfig, CalendarConfig, DayHours, DoctorConfig, ServiceAccountAuth, WeeklyHours,
)
from receptionist.integrations.clinic_settings import apply_settings

IST = ZoneInfo("Asia/Kolkata")


def _ev(eid, start, minutes=15, doctor=None, token=None, ai=True):
    end = start + timedelta(minutes=minutes)
    desc = "[via AI receptionist / UNVERIFIED]\nCaller: X\nCallback: 9830012345\n" if ai else ""
    if doctor:
        desc += f"Doctor: {doctor}\n"
    if token:
        desc += f"Token: {token}\n"
    return {"id": eid, "summary": "Appointment", "description": desc,
            "start": {"dateTime": start.isoformat()}, "end": {"dateTime": end.isoformat()}}


def test_normalize_doctor():
    assert normalize_doctor("Dr. Sen") == normalize_doctor("dr sen") == normalize_doctor("Sen") == "sen"


def test_busy_only_counts_same_doctor_and_untagged_events():
    t = datetime(2026, 11, 2, 11, 0, tzinfo=IST)
    events = [_ev("a", t, doctor="Dr. Sen"), _ev("b", t, doctor="Dr. Das"), _ev("c", t + timedelta(hours=2), ai=False)]
    busy = doctor_busy_intervals(events, "Dr. Sen")
    assert len(busy) == 2  # own booking + untagged clinic event, not Dr. Das


def test_tokens_are_per_doctor_per_day():
    day = datetime(2026, 11, 2, tzinfo=IST)
    events = [_ev("a", day.replace(hour=10), doctor="Dr. Sen", token=1),
              _ev("b", day.replace(hour=11), doctor="Dr. Sen", token=2),
              _ev("c", day.replace(hour=11), doctor="Dr. Das", token=5),
              _ev("d", (day + timedelta(days=1)).replace(hour=10), doctor="Dr. Sen", token=9)]
    assert next_token(events, "Dr. Sen", day, day + timedelta(days=1)) == 3
    assert next_token(events, "Dr. Das", day, day + timedelta(days=1)) == 6
    assert next_token([], "Dr. Sen", day, day + timedelta(days=1)) == 1


def test_leave_blocks_whole_day():
    (start, end), = leave_intervals(["2026-11-02"], IST)
    assert start == datetime(2026, 11, 2, tzinfo=IST) and end - start == timedelta(days=1)


def test_apply_settings_overlays_doctors_faqs_hours(v2_yaml):
    cfg = BusinessConfig.from_yaml_string(v2_yaml)
    data = {
        "clinicName": "CityCare Clinic", "greeting": "Hello from CityCare",
        "faqs": [{"question": "Fees?", "answer": "500"}],
        "hours": {"monday": {"open": "10:00", "close": "20:00"}, "sunday": None},
        "doctors": [{"name": "Dr. Sen", "specialty": "General physician", "slotMinutes": 15,
                     "leaveDates": ["2026-11-02", "bad"], "active": True},
                    {"name": "", "specialty": "skip me"}],
    }
    new = apply_settings(cfg, data)
    assert new.business.name == "CityCare Clinic" and new.greeting == "Hello from CityCare"
    assert [f.question for f in new.faqs] == ["Fees?"]
    assert new.hours.monday.open == "10:00" and new.hours.sunday is None
    assert len(new.doctors) == 1 and new.doctors[0].leave_dates == ["2026-11-02"]
    assert cfg.greeting != new.greeting  # original untouched


def test_apply_settings_bad_data_keeps_config(v2_yaml):
    cfg = BusinessConfig.from_yaml_string(v2_yaml)
    assert apply_settings(cfg, {"hours": {"monday": {"open": "25:99", "close": "x"}}}) is cfg
    assert apply_settings(cfg, None) is cfg


# ---- end-to-end through the agent tools with a fake calendar ----

class FakeCalendar:
    def __init__(self):
        self.events = []

    async def list_events(self, time_min, time_max, max_results=250):
        out = []
        for ev in self.events:
            s = datetime.fromisoformat(ev["start"]["dateTime"])
            if time_min <= s < time_max or (s < time_min < datetime.fromisoformat(ev["end"]["dateTime"])):
                out.append(ev)
        return out

    async def free_busy(self, a, b):
        return [(datetime.fromisoformat(e["start"]["dateTime"]), datetime.fromisoformat(e["end"]["dateTime"]))
                for e in self.events]

    async def create_event(self, *, start, end, summary, description, time_zone, location=None, attendee_email=None):
        ev = {"id": f"e{len(self.events)+1}", "summary": summary, "description": description,
              "start": {"dateTime": start.isoformat()}, "end": {"dateTime": end.isoformat()},
              "htmlLink": "x"}
        self.events.append(ev)
        return ev


def _receptionist(tmp_path, v2_yaml):
    from receptionist.agent import Receptionist
    sa = tmp_path / "sa.json"; sa.write_text("{}")
    open_all = DayHours(open="09:00", close="21:00")
    cfg = BusinessConfig.from_yaml_string(v2_yaml).model_copy(update={
        "business": BusinessConfig.from_yaml_string(v2_yaml).business.model_copy(update={"timezone": "Asia/Kolkata"}),
        "hours": WeeklyHours(**{d: open_all for d in ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")}),
        "calendar": CalendarConfig(enabled=True, auth=ServiceAccountAuth(type="service_account", service_account_file=str(sa)),
                                   appointment_duration_minutes=15, buffer_minutes=0, booking_window_days=30,
                                   earliest_booking_hours_ahead=0),
        "doctors": [DoctorConfig(name="Dr. Sen", specialty="General physician"),
                    DoctorConfig(name="Dr. Das", specialty="Paediatrician", leave_dates=[])],
    })
    lc = MagicMock(); lc.metadata.call_id = "c1"
    r = Receptionist(cfg, lc)
    fake = FakeCalendar()
    r._calendar_client = fake
    _call.agent = r
    return r, fake


def _isos(text):
    return re.findall(r"\[iso=([^\]]+)\]", text)


async def _call(tool, *args, **kw):
    # Bound FunctionTool: call the underlying function with the agent as self.
    fn = getattr(tool, "__wrapped__", None)
    if fn is not None and getattr(tool, "__self__", None) is None:
        return await fn(_call.agent, *args, **kw)
    return await tool(*args, **kw)


@pytest.mark.asyncio
async def test_two_doctors_same_time_and_tokens(tmp_path, v2_yaml):
    r, fake = _receptionist(tmp_path, v2_yaml)
    day = (datetime.now(IST) + timedelta(days=3)).strftime("%B %d")

    msg = await _call(r.check_availability, None, day, "11am")
    assert "which doctor" in msg.lower()

    out = await _call(r.check_availability, None, day, "11am", doctor="Sen")
    iso = _isos(out)[0]
    assert iso.split("T")[1].startswith("11:00")  # "11am" means 11:00
    res = await _call(r.book_appointment, None, "Asha", "9830012345", iso)
    assert "token number is 1" in res and "Dr. Sen" in res

    # Dr. Das is free at the same time despite Dr. Sen's booking
    out2 = await _call(r.check_availability, None, day, "11am", doctor="Dr. Das")
    assert iso in out2
    iso_das = _isos(out2)[0]
    res2 = await _call(r.book_appointment, None, "Ravi", "9000000000", iso_das, doctor="Dr. Das")
    assert "token number is 1" in res2

    # Second Dr. Sen booking that day gets token 2; same slot is no longer offered
    out3 = await _call(r.check_availability, None, day, "11am", doctor="Dr. Sen")
    assert iso not in out3
    iso3 = _isos(out3)[0]
    res3 = await _call(r.book_appointment, None, "Mina", "9111111111", iso3)
    assert "token number is 2" in res3
    assert any("Doctor: Dr. Sen" in e["description"] and "Token: 2" in e["description"] for e in fake.events)


@pytest.mark.asyncio
async def test_leave_day_has_no_slots(tmp_path, v2_yaml):
    r, _ = _receptionist(tmp_path, v2_yaml)
    target = datetime.now(IST) + timedelta(days=4)
    r.config.doctors[1].leave_dates = [target.strftime("%Y-%m-%d")]
    out = await _call(r.check_availability, None, target.strftime("%B %d"), "11am", doctor="Dr. Das")
    offered = _isos(out)
    assert all(not iso.startswith(target.strftime("%Y-%m-%d")) for iso in offered)


def test_other_day_slots_keep_requested_time_of_day(tmp_path):
    from receptionist.booking.availability import find_slots
    sa = tmp_path / "sa.json"; sa.write_text("{}")
    cal = CalendarConfig(enabled=True, auth=ServiceAccountAuth(type="service_account", service_account_file=str(sa)),
                         appointment_duration_minutes=15, buffer_minutes=0, booking_window_days=30,
                         earliest_booking_hours_ahead=0)
    sat_only = WeeklyHours(saturday=DayHours(open="10:00", close="13:00"))
    now = datetime(2026, 10, 28, 20, 0, tzinfo=IST)           # Wednesday evening
    preferred = datetime(2026, 10, 29, 11, 0, tzinfo=IST)     # "tomorrow 11 AM" (Thursday)
    slots = find_slots(business_hours=sat_only, business_timezone="Asia/Kolkata", calendar_config=cal,
                       preferred_dt=preferred, existing_busy=[], earliest=now,
                       latest=now + timedelta(days=30), now=now)
    times = [s.start_iso[11:16] for s in slots]
    assert all(s.start_iso.startswith("2026-10-31") for s in slots)   # nearest Saturday
    assert times[0] == "11:00" and set(times) == {"11:00", "10:45", "11:15"}


def test_unused_tools_are_not_sent(tmp_path, v2_yaml):
    from receptionist.agent import _active_tools, _tool_display_names
    r, _ = _receptionist(tmp_path, v2_yaml)
    names = set(_tool_display_names(_active_tools(r)))
    assert {"check_availability", "book_appointment", "report_emergency", "take_message"} <= names
    assert not names & {"record_intake_answer", "finalize_intake", "await_keypad_entry", "send_info_packet"}


def test_gemini_live_engine_config(v2_yaml):
    import os
    os.environ.setdefault("GOOGLE_API_KEY", "x")
    from livekit.plugins import google
    raw = BusinessConfig.from_yaml_string(v2_yaml)
    cfg = raw.model_copy(update={"voice": raw.voice.model_copy(update={"engine": "gemini_live"})})
    lc = cfg.voice.live
    model = google.realtime.RealtimeModel(model=lc.model, voice=lc.voice)
    assert cfg.voice.engine == "gemini_live" and lc.model == "gemini-3.1-flash-live-preview"
    assert model is not None


@pytest.mark.parametrize("date_in,time_in,expect_days,expect_time", [
    ("kal", "", 1, "11:00"),
    ("কাল", "সন্ধ্যায়", 1, "18:00"),
    ("कल", "शाम", 1, "18:00"),
    ("porshu", "sokal", 2, "10:00"),
    ("tomorrow", "evening", 1, "18:00"),
    ("aaj", "৫টা", 0, "17:00"),
    ("कल", "10 बजे", 1, "10:00"),
])
def test_normalize_when_multilingual(date_in, time_in, expect_days, expect_time):
    from receptionist.agent import _normalize_when
    now = datetime(2026, 10, 29, 9, 0, tzinfo=IST)
    d, t = _normalize_when(date_in, time_in, now)
    assert d == (now + timedelta(days=expect_days)).strftime("%B %d %Y")
    assert t == expect_time


@pytest.mark.asyncio
async def test_bengali_tomorrow_evening_finds_slots(tmp_path, v2_yaml):
    r, _ = _receptionist(tmp_path, v2_yaml)
    out = await _call(r.check_availability, None, "কাল", "সন্ধ্যায়", doctor="Dr. Sen")
    isos = _isos(out)
    tomorrow = (datetime.now(IST) + timedelta(days=1)).strftime("%Y-%m-%d")
    assert isos and isos[0].startswith(tomorrow) and isos[0][11:13] in ("17", "18", "19")


def test_prompt_has_todays_date(v2_yaml, tmp_path):
    from receptionist.prompts import build_system_prompt
    r, _ = _receptionist(tmp_path, v2_yaml)
    assert datetime.now(IST).strftime("%Y-%m-%d") in build_system_prompt(r.config)
