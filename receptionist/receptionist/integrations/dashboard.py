# receptionist/integrations/dashboard.py
"""Send call records to the CityCare web dashboard after every call.

Enabled when DASHBOARD_WEBHOOK_URL is set in the environment (.env). The
payload carries call metadata, messages taken, the emergency flag and the
transcript. Failures are logged and never affect the call.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import TYPE_CHECKING

import httpx

if TYPE_CHECKING:  # pragma: no cover
    from receptionist.lifecycle import CallLifecycle

logger = logging.getLogger("receptionist")
_TIMEOUT_SECONDS = 10.0


def dashboard_url() -> str | None:
    url = (os.environ.get("DASHBOARD_WEBHOOK_URL") or "").strip()
    return url or None


def _iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    try:
        return datetime.fromtimestamp(float(ts), tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def build_call_payload(lifecycle: "CallLifecycle", segments) -> dict:
    md = lifecycle.metadata
    transcript = []
    for seg in segments or []:
        role = getattr(seg.role, "value", str(seg.role))
        entry = {"role": role, "text": seg.text, "at": _iso(seg.created_at)}
        if role == "tool":
            entry["tool_output"] = (seg.tool_output or "")[:500]
        transcript.append(entry)
    return {
        "type": "call_ended",
        "call": {
            "call_id": md.call_id,
            "business_name": md.business_name,
            "caller_phone": md.caller_phone,
            "channel": "phone" if md.caller_phone else "web",
            "start_ts": md.start_ts,
            "end_ts": md.end_ts,
            "duration_seconds": md.duration_seconds,
            "outcomes": sorted(md.outcomes),
            "appointment_details": md.appointment_details,
            "faqs_answered": list(md.faqs_answered),
            "languages_detected": sorted(md.languages_detected),
            "agent_end_reason": md.agent_end_reason,
            "urgent": lifecycle.urgent,
            "urgent_keywords": sorted(lifecycle.urgent_keywords),
            "emergency_reports": list(lifecycle.emergency_reports),
            "messages": [m.to_dict() for m in lifecycle.captured_messages],
            "transcript": transcript,
        },
    }


async def post_call_to_dashboard(lifecycle: "CallLifecycle", segments) -> None:
    url = dashboard_url()
    if not url:
        return
    headers = {"X-Webhook-Secret": os.environ.get("DASHBOARD_WEBHOOK_SECRET", "")}
    payload = build_call_payload(lifecycle, segments)
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
            resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code >= 400:
            logger.error(
                "dashboard webhook returned HTTP %d", resp.status_code,
                extra={"call_id": lifecycle.metadata.call_id, "component": "integrations.dashboard"},
            )
        else:
            logger.info(
                "dashboard webhook delivered (HTTP %d)", resp.status_code,
                extra={"call_id": lifecycle.metadata.call_id, "component": "integrations.dashboard"},
            )
    except Exception as e:  # never break call teardown
        logger.error(
            "dashboard webhook failed: %s", e,
            extra={"call_id": lifecycle.metadata.call_id, "component": "integrations.dashboard"},
        )


# ---------------------------------------------------------------------------
# Live calls to the website during a call (hospital features)
# ---------------------------------------------------------------------------

def api_url(path: str) -> str | None:
    """Website URL for `path` (e.g. "/api/agent/report-status"), built from DASHBOARD_WEBHOOK_URL."""
    from urllib.parse import urlsplit, urlunsplit
    hook = dashboard_url()
    if not hook:
        return None
    parts = urlsplit(hook)
    return urlunsplit((parts.scheme, parts.netloc, path, "", ""))


def _headers() -> dict:
    return {"X-Webhook-Secret": os.environ.get("DASHBOARD_WEBHOOK_SECRET", "")}


async def post_emergency_alert(call_id: str, *, keywords=(), report: dict | None = None,
                               caller_phone: str | None = None) -> None:
    """Tell the website NOW (not at call end) so staff see a red alert immediately."""
    url = dashboard_url()
    if not url:
        return
    payload = {"type": "emergency_alert", "alert": {
        "call_id": call_id, "keywords": sorted(set(keywords or ())), "report": report or None,
        "caller_phone": caller_phone, "at": datetime.now(timezone.utc).isoformat(),
    }}
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(url, json=payload, headers=_headers())
    except Exception as e:
        logger.error("emergency alert to dashboard failed: %s", e,
                     extra={"call_id": call_id, "component": "integrations.dashboard"})


async def fetch_report_status(phone: str, report_id: str | None = None) -> dict | None:
    """Ask the website which lab/scan reports exist for this phone number."""
    url = api_url("/api/agent/report-status")
    if not url:
        return None
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            resp = await client.post(url, json={"phone": phone, "report_id": report_id}, headers=_headers())
        return resp.json() if resp.status_code == 200 else None
    except Exception as e:
        logger.warning("report status lookup failed: %s", e, extra={"component": "integrations.dashboard"})
        return None


async def fetch_queue() -> dict | None:
    """Today's OPD queue (now-serving token per doctor) from the website."""
    url = api_url("/api/queue")
    if not url:
        return None
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(url)
        return resp.json() if resp.status_code == 200 else None
    except Exception as e:
        logger.warning("queue lookup failed: %s", e, extra={"component": "integrations.dashboard"})
        return None
