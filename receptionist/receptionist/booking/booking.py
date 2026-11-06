# receptionist/booking/booking.py
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from receptionist.booking.client import GoogleCalendarClient
from receptionist.booking.models import BookingResult, SlotProposal

logger = logging.getLogger("receptionist")


def _clean_field(value: str | None) -> str:
    return " ".join((value or "").replace("\r", " ").replace("\n", " ").replace("\x00", " ").split())


class SlotNoLongerAvailableError(Exception):
    """Raised when the proposed slot was free at check_availability time but is now busy.

    The caller (tool handler) should catch this, run availability again, and
    offer the caller new alternatives.
    """


async def book_appointment(
    *,
    slot: SlotProposal,
    caller_name: str,
    callback_number: str,
    call_id: str,
    time_zone: str,
    client: GoogleCalendarClient,
    notes: str | None,
    caller_email: str | None = None,
    doctor: str | None = None,
    token: int | None = None,
    is_busy=None,
) -> BookingResult:
    """Book the given slot on the calendar.

    Performs a last-second free/busy check for the exact slot to detect races
    between check_availability and this call. On race, raises
    SlotNoLongerAvailableError; the tool handler turns that into an LLM-facing
    message offering alternatives.

    When caller_email is given, the caller is added as an OPTIONAL attendee
    and Google sends them the standard calendar invitation. Optional attendees
    do not affect the organizer's free/busy if they decline.
    """
    start = datetime.fromisoformat(slot.start_iso)
    end = datetime.fromisoformat(slot.end_iso)

    # Race detection: re-check JUST this slot. With doctors, the caller passes
    # a doctor-aware check (other doctors' bookings don't block this one).
    if is_busy is not None:
        busy_now = await is_busy(start, end)
    else:
        busy_now = await client.free_busy(start, end)
    if busy_now:
        logger.info(
            "Slot taken between check_availability and book_appointment: %s",
            slot.start_iso,
            extra={"call_id": call_id, "component": "booking.booking"},
        )
        raise SlotNoLongerAvailableError(slot.start_iso)

    # Build the event description. UNVERIFIED tag is permanent and intentional —
    # staff viewing the event need to see that the AI took this booking without
    # identity verification.
    booked_at = datetime.now(timezone.utc).isoformat()
    caller_name = _clean_field(caller_name)
    callback_number = _clean_field(callback_number)
    caller_email = _clean_field(caller_email) or None
    notes = _clean_field(notes) or None

    description_lines = [
        "[via AI receptionist / UNVERIFIED]",
        f"Caller: {caller_name}",
        f"Callback: {callback_number}",
        f"Email: {caller_email or '(none)'}",
        *( [f"Doctor: {_clean_field(doctor)}"] if doctor else [] ),
        *( [f"Token: {int(token)}"] if token else [] ),
        f"Booked: {booked_at}",
        f"Call ID: {call_id}",
        f"Notes: {notes or '(none)'}",
    ]
    description = "\n".join(description_lines)

    summary = f"Appointment: {caller_name}" + (f" ({_clean_field(doctor)})" if doctor else "")

    result = await client.create_event(
        start=start,
        end=end,
        summary=summary,
        description=description,
        time_zone=time_zone,
        attendee_email=caller_email,
    )

    logger.info(
        "Appointment booked: event_id=%s at %s",
        result["id"], slot.start_iso,
        extra={"call_id": call_id, "component": "booking.booking"},
    )

    return BookingResult(
        event_id=result["id"],
        start_iso=slot.start_iso,
        end_iso=slot.end_iso,
        html_link=result["htmlLink"],
    )


# ---------------------------------------------------------------------------
# Find / cancel / reschedule existing appointments
# ---------------------------------------------------------------------------

AI_TAG = "[via AI receptionist"
_CALLBACK_RE = re.compile(r"^Callback:\s*(.*)$", re.MULTILINE)
_DOCTOR_RE = re.compile(r"^Doctor:\s*(.*)$", re.MULTILINE)
_TOKEN_RE = re.compile(r"^Token:\s*(\d+)\s*$", re.MULTILINE)


def phone_key(value: str | None) -> str:
    """Last 10 digits of a phone number, so '+91 98300 12345' == '9830012345'."""
    digits = re.sub(r"\D", "", value or "")
    return digits[-10:]


@dataclass
class ExistingAppointment:
    event_id: str
    start_iso: str
    end_iso: str
    summary: str
    description: str


def _event_times(event: dict) -> tuple[str, str] | None:
    start = (event.get("start") or {}).get("dateTime")
    end = (event.get("end") or {}).get("dateTime")
    if not start or not end:
        return None  # all-day events are never AI bookings
    return start, end


async def find_appointments(
    *,
    client: GoogleCalendarClient,
    callback_number: str,
    caller_name: str | None,
    time_min: datetime,
    time_max: datetime,
) -> list[ExistingAppointment]:
    """Upcoming AI-booked appointments whose callback number matches.

    The phone number is the identity check: an appointment is only returned
    when its stored callback number matches the one the caller gives (last 10
    digits). The name only narrows the list when several bookings share the
    number.
    """
    key = phone_key(callback_number)
    if len(key) < 7:
        return []
    events = await client.list_events(time_min, time_max)
    found: list[ExistingAppointment] = []
    for ev in events:
        desc = ev.get("description") or ""
        if AI_TAG not in desc or ev.get("status") == "cancelled":
            continue
        m = _CALLBACK_RE.search(desc)
        if not m or phone_key(m.group(1)) != key:
            continue
        times = _event_times(ev)
        if times is None:
            continue
        found.append(ExistingAppointment(
            event_id=ev["id"], start_iso=times[0], end_iso=times[1],
            summary=ev.get("summary") or "", description=desc,
        ))
    if caller_name and len(found) > 1:
        name = _clean_field(caller_name).lower()
        by_name = [a for a in found if name and name in a.summary.lower()]
        if by_name:
            found = by_name
    return found


async def cancel_appointment(
    *, client: GoogleCalendarClient, appointment: ExistingAppointment, call_id: str,
) -> None:
    await client.delete_event(appointment.event_id)
    logger.info(
        "Appointment cancelled: event_id=%s (was %s)",
        appointment.event_id, appointment.start_iso,
        extra={"call_id": call_id, "component": "booking.booking"},
    )


async def reschedule_appointment(
    *,
    client: GoogleCalendarClient,
    appointment: ExistingAppointment,
    new_slot: SlotProposal,
    time_zone: str,
    call_id: str,
    is_busy=None,
    new_token: int | None = None,
) -> None:
    """Move an existing appointment to new_slot.

    Re-checks free/busy for the new slot first. The appointment's own current
    time is ignored in that check, so a caller can shift by a few minutes.
    Raises SlotNoLongerAvailableError if something else is there now.
    """
    start = datetime.fromisoformat(new_slot.start_iso)
    end = datetime.fromisoformat(new_slot.end_iso)
    own_start = datetime.fromisoformat(appointment.start_iso)
    own_end = datetime.fromisoformat(appointment.end_iso)

    if is_busy is not None:
        if await is_busy(start, end, ignore_event_id=appointment.event_id):
            raise SlotNoLongerAvailableError(new_slot.start_iso)
    else:
        busy = await client.free_busy(start, end)
        others = [
            (b_start, b_end) for b_start, b_end in busy
            if not (b_start >= own_start and b_end <= own_end)
        ]
        if others:
            raise SlotNoLongerAvailableError(new_slot.start_iso)

    note = f"Rescheduled: {datetime.now(timezone.utc).isoformat()} (call {call_id})"
    base = appointment.description.rstrip()
    if new_token:
        if _TOKEN_RE.search(base):
            base = _TOKEN_RE.sub(f"Token: {int(new_token)}", base)
        else:
            base += f"\nToken: {int(new_token)}"
    description = (base + "\n" + note).strip()
    await client.move_event(
        appointment.event_id, start=start, end=end,
        time_zone=time_zone, description=description,
    )
    logger.info(
        "Appointment rescheduled: event_id=%s %s -> %s",
        appointment.event_id, appointment.start_iso, new_slot.start_iso,
        extra={"call_id": call_id, "component": "booking.booking"},
    )


# ---------------------------------------------------------------------------
# Doctors + OPD tokens (one shared clinic calendar)
# ---------------------------------------------------------------------------

def normalize_doctor(name: str | None) -> str:
    n = re.sub(r"^(dr\.?|doctor)\s+", "", (name or "").strip(), flags=re.IGNORECASE)
    return " ".join(n.lower().split())


def event_doctor(event: dict) -> str | None:
    m = _DOCTOR_RE.search(event.get("description") or "")
    return m.group(1).strip() if m else None


def event_token(event: dict) -> int | None:
    m = _TOKEN_RE.search(event.get("description") or "")
    return int(m.group(1)) if m else None


def doctor_busy_intervals(events: list[dict], doctor: str, *, ignore_event_id: str | None = None):
    """Busy intervals that block `doctor`: their own bookings plus any timed
    event that isn't tagged with a doctor (e.g. a clinic meeting)."""
    key = normalize_doctor(doctor)
    busy = []
    for ev in events:
        if ev.get("status") == "cancelled" or ev.get("id") == ignore_event_id:
            continue
        times = _event_times(ev)
        if times is None:
            continue
        tagged = event_doctor(ev)
        if tagged is None or normalize_doctor(tagged) == key:
            busy.append((datetime.fromisoformat(times[0].replace("Z", "+00:00")),
                         datetime.fromisoformat(times[1].replace("Z", "+00:00"))))
    return busy


def next_token(events: list[dict], doctor: str, day_start: datetime, day_end: datetime,
               *, ignore_event_id: str | None = None) -> int:
    """Next OPD token for `doctor` on that day: highest token issued + 1."""
    key = normalize_doctor(doctor)
    highest = 0
    for ev in events:
        if ev.get("id") == ignore_event_id or ev.get("status") == "cancelled":
            continue
        tagged = event_doctor(ev)
        times = _event_times(ev)
        if tagged is None or times is None or normalize_doctor(tagged) != key:
            continue
        start = datetime.fromisoformat(times[0].replace("Z", "+00:00"))
        if day_start <= start < day_end:
            highest = max(highest, event_token(ev) or 0)
    return highest + 1


def leave_intervals(leave_dates: list[str], tz) -> list[tuple[datetime, datetime]]:
    """Whole-day busy blocks for a doctor's leave days."""
    out = []
    for d in leave_dates or []:
        try:
            day = datetime.fromisoformat(d).replace(tzinfo=tz)
        except ValueError:
            continue
        out.append((day, day + timedelta(days=1)))
    return out
