# tests/test_dashboard_integration.py — emergency detection + dashboard webhook payload
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from receptionist.integrations.dashboard import build_call_payload, post_call_to_dashboard
from receptionist.integrations.emergency import detect_emergency
from receptionist.messaging.models import Message
from receptionist.transcript.capture import SpeakerRole, TranscriptSegment


@pytest.mark.parametrize("text,expected", [
    ("My father has chest pain since morning", "chest pain"),
    ("I cant breathe", "cant breathe"),
    ("বুকে ব্যথা হচ্ছে", "বুকে ব্যথা"),
    ("seene mein dard hai", "seene mein dard"),
])
def test_detects_emergency(text, expected):
    assert expected in detect_emergency(text)


@pytest.mark.parametrize("text", ["I want to book for a fever", "fitbit sync", "", None])
def test_no_false_alarm(text):
    assert detect_emergency(text) == []


def _lifecycle():
    from receptionist.lifecycle import CallLifecycle
    from receptionist.config import BusinessConfig
    cfg = MagicMock()
    cfg.business.name = "CityCare Clinic"
    cfg.email = None
    cfg.messages.channels = []
    lc = CallLifecycle(config=cfg, call_id="room-1", caller_phone=None)
    return lc


def test_payload_contains_urgent_messages_and_transcript():
    lc = _lifecycle()
    lc.mark_urgent(["chest pain"], report={"symptoms": "chest pain"})
    lc.record_captured_message(Message(caller_name="Ritu", callback_number="98", message="call back",
                                       business_name="CityCare Clinic"))
    lc.metadata.mark_finalized()
    segs = [TranscriptSegment(role=SpeakerRole.USER, text="hello", created_at=1_700_000_000.0)]
    p = build_call_payload(lc, segs)["call"]
    assert p["urgent"] is True and p["urgent_keywords"] == ["chest pain"]
    assert p["channel"] == "web"
    assert p["messages"][0]["caller_name"] == "Ritu"
    assert p["transcript"][0] == {"role": "user", "text": "hello", "at": "2023-11-14T22:13:20+00:00"}


@pytest.mark.asyncio
async def test_post_skipped_without_url(monkeypatch):
    monkeypatch.delenv("DASHBOARD_WEBHOOK_URL", raising=False)
    await post_call_to_dashboard(_lifecycle(), [])  # no exception, no request


@pytest.mark.asyncio
async def test_post_sends_secret_header(monkeypatch, respx_mock):
    import httpx
    monkeypatch.setenv("DASHBOARD_WEBHOOK_URL", "http://localhost:4000/api/webhooks/agent")
    monkeypatch.setenv("DASHBOARD_WEBHOOK_SECRET", "s3cret")
    route = respx_mock.post("http://localhost:4000/api/webhooks/agent").mock(
        return_value=httpx.Response(200, json={"ok": True}))
    lc = _lifecycle(); lc.metadata.mark_finalized()
    await post_call_to_dashboard(lc, [])
    assert route.called
    assert route.calls[0].request.headers["X-Webhook-Secret"] == "s3cret"
