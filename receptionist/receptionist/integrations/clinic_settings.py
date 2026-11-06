# receptionist/integrations/clinic_settings.py
"""Pull live clinic settings (doctors, hours, FAQs, greeting) from the website.

Staff edit these on the dashboard's Clinic settings page. At the start of every
call the agent asks the website for the latest version and overlays it on the
YAML config. If the website is unreachable, the YAML config is used unchanged.
"""
from __future__ import annotations

import logging
import os
from urllib.parse import urlsplit, urlunsplit

import httpx

from receptionist.config import (
    BedInfo, BusinessConfig, DepartmentInfo, DoctorConfig, FAQEntry, HospitalConfig, LabTestInfo, WeeklyHours,
)

logger = logging.getLogger("receptionist")
_TIMEOUT_SECONDS = 4.0
_DAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")


def settings_url() -> str | None:
    explicit = (os.environ.get("DASHBOARD_SETTINGS_URL") or "").strip()
    if explicit:
        return explicit
    hook = (os.environ.get("DASHBOARD_WEBHOOK_URL") or "").strip()
    if not hook:
        return None
    parts = urlsplit(hook)
    return urlunsplit((parts.scheme, parts.netloc, "/api/agent/settings", "", ""))


async def fetch_settings() -> dict | None:
    url = settings_url()
    if not url:
        return None
    headers = {"X-Webhook-Secret": os.environ.get("DASHBOARD_WEBHOOK_SECRET", "")}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
            resp = await client.get(url, headers=headers)
        if resp.status_code != 200:
            logger.warning("clinic settings: HTTP %d from website", resp.status_code,
                           extra={"component": "integrations.settings"})
            return None
        data = resp.json()
        return data.get("settings") if isinstance(data, dict) else None
    except Exception as e:
        logger.warning("clinic settings unavailable (%s); using YAML config", e,
                       extra={"component": "integrations.settings"})
        return None


def _hours(raw) -> WeeklyHours | None:
    if not isinstance(raw, dict):
        return None
    clean = {}
    for day in _DAYS:
        v = raw.get(day)
        if isinstance(v, dict) and v.get("open") and v.get("close"):
            clean[day] = {"open": v["open"], "close": v["close"]}
        else:
            clean[day] = None
    return WeeklyHours(**clean)


def _int(v):
    try:
        return int(v) if v is not None and str(v).strip() != "" else None
    except (TypeError, ValueError):
        return None


def _tests(items, kind="test") -> list[LabTestInfo]:
    out = []
    for t in items or []:
        if isinstance(t, dict) and (t.get("name") or "").strip():
            out.append(LabTestInfo(
                name=t["name"].strip(), price=(t.get("price") or "").strip(),
                prep=(t.get("prep") or "").strip(), report_time=(t.get("reportTime") or "").strip(),
                includes=(t.get("includes") or "").strip(),
            ))
    return out


def _hospital(data: dict) -> HospitalConfig | None:
    """Hospital section of the website settings (None when nothing is filled in)."""
    em = data.get("emergency") or {}
    lab = data.get("lab") or {}
    h = HospitalConfig(
        emergency_phone=(em.get("phone") or "").strip(),
        ambulance_phone=(em.get("ambulancePhone") or "").strip(),
        emergency_note=(em.get("note") or "").strip(),
        visiting_hours=(data.get("visitingHours") or "").strip(),
        admission_info=(data.get("admissionInfo") or "").strip(),
        insurance_info=(data.get("insuranceInfo") or "").strip(),
        departments=[DepartmentInfo(name=d["name"].strip(), description=(d.get("description") or "").strip(),
                                    location=(d.get("location") or "").strip())
                     for d in data.get("departments") or [] if isinstance(d, dict) and (d.get("name") or "").strip()],
        beds=[BedInfo(ward=b["ward"].strip(), available=_int(b.get("available")), total=_int(b.get("total")))
              for b in data.get("beds") or [] if isinstance(b, dict) and (b.get("ward") or "").strip()],
        beds_updated=data.get("bedsUpdatedAt") or None,
        lab_name=(lab.get("name") or "").strip() or "Diagnostic Lab",
        lab_bookable=bool(lab.get("bookable")),
        lab_tests=_tests(lab.get("tests")),
        packages=_tests(lab.get("packages")),
    )
    filled = (h.emergency_phone or h.ambulance_phone or h.visiting_hours or h.admission_info
              or h.insurance_info or h.departments or h.beds or h.lab_tests or h.packages)
    return h if filled else None


def apply_settings(config: BusinessConfig, data: dict | None) -> BusinessConfig:
    """Return a copy of `config` with website settings applied (never raises)."""
    if not data:
        return config
    try:
        update: dict = {}
        if (data.get("clinicName") or "").strip():
            update["business"] = config.business.model_copy(update={"name": data["clinicName"].strip()})
        for key, field in (("greeting", "greeting"), ("afterHoursMessage", "after_hours_message")):
            if (data.get(key) or "").strip():
                update[field] = data[key].strip()
        if (data.get("extraInstructions") or "").strip():
            update["personality"] = config.personality.rstrip() + "\n" + data["extraInstructions"].strip()
        hours = _hours(data.get("hours"))
        if hours is not None:
            update["hours"] = hours
        if isinstance(data.get("faqs"), list):
            update["faqs"] = [
                FAQEntry(question=f["question"], answer=f["answer"])
                for f in data["faqs"] if f.get("question") and f.get("answer")
            ]
        if isinstance(data.get("doctors"), list):
            docs = []
            for d in data["doctors"]:
                if not (d.get("name") or "").strip():
                    continue
                docs.append(DoctorConfig(
                    name=d["name"].strip(),
                    specialty=(d.get("specialty") or "").strip(),
                    hours=_hours(d.get("hours")) if d.get("useOwnHours") else None,
                    slot_minutes=d.get("slotMinutes") or None,
                    leave_dates=d.get("leaveDates") or [],
                    fee=(d.get("fee") or None),
                    active=d.get("active", True),
                    department=(d.get("department") or "").strip(),
                    room=(d.get("room") or "").strip(),
                    substitute=(d.get("substitute") or "").strip(),
                ))
            hospital = _hospital(data)
            if hospital is not None:
                update["hospital"] = hospital
                lab = data.get("lab") or {}
                if hospital.lab_bookable and (hospital.lab_tests or hospital.packages):
                    docs.append(DoctorConfig(
                        name=hospital.lab_name,
                        specialty="Lab tests, scans and health packages",
                        hours=_hours(lab.get("hours")) if lab.get("useOwnHours") else None,
                        slot_minutes=lab.get("slotMinutes") or None,
                        department="Diagnostics",
                    ))
            update["doctors"] = docs
        new = config.model_copy(update=update)
        logger.info("clinic settings applied from website (%d doctors, %d FAQs)",
                    len(new.doctors), len(new.faqs), extra={"component": "integrations.settings"})
        return new
    except Exception:
        logger.exception("clinic settings could not be applied; using YAML config")
        return config
