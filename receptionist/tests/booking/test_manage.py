# tests/booking/test_manage.py — find / cancel / reschedule
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from receptionist.booking.booking import (
    ExistingAppointment, SlotNoLongerAvailableError, cancel_appointment,
    find_appointments, phone_key, reschedule_appointment,
)
from receptionist.booking.models import SlotProposal

T0 = datetime(2026, 10, 27, tzinfo=timezone.utc)
T1 = datetime(2026, 12, 31, tzinfo=timezone.utc)


def _ev(eid, number, name="Kushal Ghosh", start="2026-10-28T11:15:00+05:30",
        end="2026-10-28T11:30:00+05:30", ai=True):
    desc = (("[via AI receptionist / UNVERIFIED]\n" if ai else "")
            + f"Caller: {name}\nCallback: {number}\nEmail: (none)")
    return {"id": eid, "summary": f"Appointment: {name}", "description": desc,
            "start": {"dateTime": start}, "end": {"dateTime": end}}


def test_phone_key_normalizes():
    assert phone_key("+91 98300-12345") == phone_key("9830012345") == "9830012345"


@pytest.mark.asyncio
async def test_find_matches_only_same_number_and_ai_events():
    client = MagicMock()
    client.list_events = AsyncMock(return_value=[
        _ev("a", "+91 98300 12345"),
        _ev("b", "9999999999"),                  # other caller
        _ev("c", "9830012345", ai=False),        # manual event, not AI-booked
        {"id": "d", "description": "[via AI receptionist]\nCallback: 9830012345",
         "start": {"date": "2026-10-29"}, "end": {"date": "2026-10-30"}},  # all-day
    ])
    found = await find_appointments(client=client, callback_number="98300 12345",
                                    caller_name=None, time_min=T0, time_max=T1)
    assert [a.event_id for a in found] == ["a"]


@pytest.mark.asyncio
async def test_find_rejects_too_short_number():
    client = MagicMock()
    client.list_events = AsyncMock(return_value=[_ev("a", "123")])
    assert await find_appointments(client=client, callback_number="123",
                                   caller_name=None, time_min=T0, time_max=T1) == []
    client.list_events.assert_not_called()


@pytest.mark.asyncio
async def test_find_name_narrows_when_several():
    client = MagicMock()
    client.list_events = AsyncMock(return_value=[
        _ev("a", "9830012345", name="Kushal Ghosh"),
        _ev("b", "9830012345", name="Riya Ghosh"),
    ])
    found = await find_appointments(client=client, callback_number="9830012345",
                                    caller_name="riya ghosh", time_min=T0, time_max=T1)
    assert [a.event_id for a in found] == ["b"]


def _appt():
    return ExistingAppointment(event_id="a", start_iso="2026-10-28T11:15:00+05:30",
                               end_iso="2026-10-28T11:30:00+05:30",
                               summary="Appointment: Kushal Ghosh",
                               description="[via AI receptionist / UNVERIFIED]")


@pytest.mark.asyncio
async def test_cancel_deletes_event():
    client = MagicMock(); client.delete_event = AsyncMock()
    await cancel_appointment(client=client, appointment=_appt(), call_id="c1")
    client.delete_event.assert_awaited_once_with("a")


@pytest.mark.asyncio
async def test_reschedule_moves_event_when_free():
    client = MagicMock()
    client.free_busy = AsyncMock(return_value=[])
    client.move_event = AsyncMock(return_value={})
    slot = SlotProposal("2026-10-29T15:00:00+05:30", "2026-10-29T15:15:00+05:30")
    await reschedule_appointment(client=client, appointment=_appt(), new_slot=slot,
                                 time_zone="Asia/Kolkata", call_id="c1")
    kw = client.move_event.call_args.kwargs
    assert client.move_event.call_args.args == ("a",)
    assert kw["start"].isoformat() == slot.start_iso
    assert "Rescheduled" in kw["description"]


@pytest.mark.asyncio
async def test_reschedule_ignores_own_slot_but_blocks_others():
    appt = _appt()
    own = (datetime.fromisoformat(appt.start_iso), datetime.fromisoformat(appt.end_iso))
    client = MagicMock(); client.move_event = AsyncMock(return_value={})
    slot = SlotProposal("2026-10-28T11:20:00+05:30", "2026-10-28T11:35:00+05:30")

    client.free_busy = AsyncMock(return_value=[own])  # only itself -> allowed
    await reschedule_appointment(client=client, appointment=appt, new_slot=slot,
                                 time_zone="Asia/Kolkata", call_id="c1")

    other = (datetime.fromisoformat("2026-10-28T11:30:00+05:30"),
             datetime.fromisoformat("2026-10-28T11:45:00+05:30"))
    client.free_busy = AsyncMock(return_value=[own, other])
    with pytest.raises(SlotNoLongerAvailableError):
        await reschedule_appointment(client=client, appointment=appt, new_slot=slot,
                                     time_zone="Asia/Kolkata", call_id="c1")
