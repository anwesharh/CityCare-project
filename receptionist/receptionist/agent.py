# receptionist/agent.py
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal, Optional
from zoneinfo import ZoneInfo

from dateutil import parser as dateparser
from dotenv import load_dotenv

from livekit import agents, api, rtc
from livekit.agents import (
    AgentServer, AgentSession, Agent, RunContext,
    function_tool, room_io, get_job_context,
)
from livekit.plugins import openai, noise_cancellation, google, sarvam, silero

from receptionist.booking.availability import find_slots
from receptionist.booking.models import SlotProposal
from receptionist.config import BusinessConfig, load_config
from receptionist.info_packets import is_valid_email_destination, send_info_packet_email
from receptionist.intakes.dtmf_capture import CaptureStatus, DigitCaptureBuffer
from receptionist.lifecycle import CallLifecycle
from receptionist.messaging.dispatcher import Dispatcher
from receptionist.messaging.models import DispatchContext, Message
from receptionist.prompts import build_system_prompt
from receptionist.voice_auth import resolve_voice_bearer_async

load_dotenv(".env.local")
load_dotenv(".env")

logger = logging.getLogger("receptionist")

DEFAULT_CONFIG_DIR = Path("config/businesses")
DEFAULT_AGENT_NAME = "receptionist"
_BENIGN_ENGINE_CLOSED_MESSAGE = "engine: connection error: engine is closed"
_LIVEKIT_OPERATION_TIMEOUT_SECONDS = 10.0


def _build_realtime_model_kwargs(voice_config, api_key: str | None) -> dict:
    """Assemble constructor kwargs for openai.realtime.RealtimeModel.

    `reasoning` and `max_response_output_tokens` are only included when the
    business config requests them AND the installed livekit-plugins-openai
    exposes those parameters on the relevant API surface. This keeps the call
    working across plugin versions: older plugins (pre-1.6) silently get the
    minimal kwargs.

    Note: in 1.6 `max_response_output_tokens` is a constructor parameter on
    some builds and an `update_options()` setter on others. We pass it as a
    constructor kwarg when supported there; `_apply_realtime_options` covers
    the setter path after construction.
    """
    import inspect

    kwargs: dict = {
        "model": voice_config.model,
        "voice": voice_config.voice_id,
        "api_key": api_key,
    }
    supported = inspect.signature(
        openai.realtime.RealtimeModel.__init__
    ).parameters

    if voice_config.reasoning_effort is not None and "reasoning" in supported:
        try:
            from livekit.plugins.openai.realtime.realtime_model import (
                RealtimeReasoning,
            )

            kwargs["reasoning"] = RealtimeReasoning(
                effort=voice_config.reasoning_effort
            )
        except Exception:
            logger.warning(
                "voice.reasoning_effort set but RealtimeReasoning unavailable; "
                "ignoring reasoning_effort=%r",
                voice_config.reasoning_effort,
                extra={"component": "agent.realtime"},
            )

    if (
        voice_config.max_response_output_tokens is not None
        and "max_response_output_tokens" in supported
    ):
        kwargs["max_response_output_tokens"] = (
            voice_config.max_response_output_tokens
        )

    return kwargs


def _build_pipeline_llm(pipeline_config):
    """Gemini LLM with automatic fallback to backup models.

    Free-tier Gemini models often return 503 "high demand". FallbackAdapter
    moves to the next model in the list when one fails, so the caller still
    gets an answer.
    """
    models = [pipeline_config.llm_model] + [
        m for m in pipeline_config.llm_fallback_models
        if m and m != pipeline_config.llm_model
    ]
    def _fast(m: str):
        # Thinking adds 1-3 s per turn; a receptionist doesn't need it.
        if getattr(pipeline_config, "llm_thinking", False):
            return google.LLM(model=m)
        if "gemini-2" in m:
            return google.LLM(model=m, thinking_config={"thinking_budget": 0})
        return google.LLM(model=m, thinking_config={"thinking_level": "minimal"})

    llms = []
    for m in models:
        try:
            llms.append(_fast(m))
        except Exception:
            llms.append(google.LLM(model=m))
    # Last resort: the main model with default settings, in case a model
    # rejects the thinking option.
    llms.append(google.LLM(model=models[0]))
    return agents.llm.FallbackAdapter(
        llms, attempt_timeout=25.0, max_retry_per_llm=0, retry_interval=0.3,
    )


def _apply_realtime_options(realtime_model, voice_config) -> None:
    """Apply post-construction RealtimeModel options that aren't constructor args.

    `max_response_output_tokens` is an `update_options()` setter in some
    livekit-plugins-openai 1.6 builds rather than a constructor kwarg. If
    `_build_realtime_model_kwargs` already passed it to the constructor, this
    is a harmless no-op re-apply; if not, this is where the cap lands. Guarded
    so an unsupported setter never breaks call setup.
    """
    if voice_config.max_response_output_tokens is None:
        return
    update_options = getattr(realtime_model, "update_options", None)
    import inspect

    if (
        update_options is None
        or "max_response_output_tokens"
        not in inspect.signature(update_options).parameters
    ):
        logger.warning(
            "voice.max_response_output_tokens=%r set but the installed "
            "livekit-plugins-openai RealtimeModel has no update_options("
            "max_response_output_tokens=...); cap NOT applied",
            voice_config.max_response_output_tokens,
            extra={"component": "agent.realtime"},
        )
        return
    try:
        update_options(
            max_response_output_tokens=voice_config.max_response_output_tokens
        )
    except Exception:
        logger.warning(
            "failed to apply max_response_output_tokens=%r via update_options",
            voice_config.max_response_output_tokens,
            extra={"component": "agent.realtime"},
        )


# Substrings in a realtime error message that mean "the model's response was
# rejected and nothing will be spoken unless we re-trigger it." These are the
# transient failures worth a filler + retry (the caller would otherwise hear
# dead air until they speak again). The dominant production case is
# `rate_limit_exceeded` on token-rate-limited OpenAI tiers.
#
# NOTE for future refactors: on livekit-plugins-openai 1.6 the rejected-response
# message renders as "...response failed with error type: invalid_request_error"
# (the specific rate-limit code lives in the API error body, not str()). So the
# `"response failed"` hint is the one that actually matches today; `"rate_limit"`
# is kept as forward-looking belt-and-braces. Don't remove `"response failed"`.
_RECOVERABLE_REALTIME_ERROR_HINTS = (
    "rate_limit",
    "response failed",
    "server_error",
    "active response",
)

# Per-call cap on automatic recoveries. Once the OpenAI account has adequate
# rate-limit headroom a recovery should fix the call in 1-2 attempts; a hard
# cap prevents a *sustained* rate limit from turning the rest of the call into
# an endless "One moment." → retry → fail loop. After the cap is hit the agent
# stops auto-recovering and the existing idle/silence safety nets take over.
_MAX_REALTIME_RECOVERIES_PER_CALL = 3


class _RealtimeRecovery:
    """Speaks a short filler and re-triggers a model response after a
    recoverable realtime error, so a rejected response doesn't leave the
    caller in silence.

    Concurrency: realtime errors can arrive in bursts (the server may reject
    several queued responses). An in-flight guard collapses a burst into a
    single filler + single retry so we don't stack speech or hammer the API.
    A per-call recovery counter caps total attempts so a sustained failure
    can't loop forever. The handler never raises — call recovery must not
    crash the session.
    """

    def __init__(
        self,
        session,
        *,
        filler_text: str = "One moment.",
        backoff_seconds: float = 0.8,
        max_recoveries: int = _MAX_REALTIME_RECOVERIES_PER_CALL,
    ) -> None:
        self._session = session
        self._filler_text = filler_text
        self._backoff_seconds = backoff_seconds
        self._max_recoveries = max_recoveries
        self._in_flight = False
        self._recovery_count = 0

    def _is_recoverable(self, error_event) -> bool:
        err = getattr(error_event, "error", None)
        if err is None:
            return False
        # Explicit non-recoverable flag from the SDK wins.
        if getattr(err, "recoverable", True) is False:
            return False
        inner = getattr(err, "error", None)
        message = str(inner) if inner is not None else str(err)
        message = message.lower()
        return any(hint in message for hint in _RECOVERABLE_REALTIME_ERROR_HINTS)

    async def handle_error(self, error_event) -> None:
        try:
            if self._in_flight:
                return
            if self._recovery_count >= self._max_recoveries:
                logger.warning(
                    "realtime recovery: per-call cap (%d) reached; not "
                    "auto-recovering further (sustained realtime failure)",
                    self._max_recoveries,
                    extra={"component": "agent.realtime_recovery"},
                )
                return
            if not self._is_recoverable(error_event):
                return
            self._in_flight = True
            self._recovery_count += 1
            try:
                if self._filler_text:
                    try:
                        # add_to_chat_ctx=False: the filler must not enter the
                        # conversation context — on a speech-to-speech model the
                        # full context is re-sent every turn, so a context-bound
                        # filler would be re-billed each turn (ironic on the very
                        # token-rate problem this recovers from).
                        self._session.say(self._filler_text, add_to_chat_ctx=False)
                    except Exception:
                        logger.warning(
                            "realtime recovery: filler say() failed",
                            extra={"component": "agent.realtime_recovery"},
                        )
                if self._backoff_seconds > 0:
                    await asyncio.sleep(self._backoff_seconds)
                try:
                    self._session.generate_reply()
                    logger.info(
                        "realtime recovery: re-triggered model response after "
                        "recoverable error (attempt %d/%d)",
                        self._recovery_count, self._max_recoveries,
                        extra={"component": "agent.realtime_recovery"},
                    )
                except Exception:
                    logger.warning(
                        "realtime recovery: generate_reply() failed",
                        extra={"component": "agent.realtime_recovery"},
                    )
            finally:
                self._in_flight = False
        except Exception:
            logger.exception(
                "realtime recovery handler crashed",
                extra={"component": "agent.realtime_recovery"},
            )


_BACKGROUND_TASKS: set[asyncio.Task] = set()
_GENERATION_WATCHDOG_THREAD: threading.Thread | None = None
_GENERATION_WATCHDOG_INTERVAL_SECONDS = 2.0


def _trace_stage(stage: str, call_id: str) -> None:
    """Log a handle_call setup stage. Replaces the per-PID breadcrumb file
    tracer (stderr print + synchronous file writes on the event loop) that
    was added to diagnose interleaved multi-process log writes; that bug is
    closed and the stage names are still what troubleshooting docs look for.
    """
    logger.info(
        "handle_call stage=%s",
        stage,
        extra={"call_id": call_id, "component": "agent.setup"},
    )


# Spoken/returned when a transfer is attempted on an intake_only line. The
# tool path returns this to the LLM; the DTMF handler (issue #16) inherits the
# same refusal via _execute_transfer. Single source of truth so the two paths
# cannot drift.
_INTAKE_ONLY_TRANSFER_REFUSAL = (
    "This intake line cannot transfer calls. Offer to take a "
    "message with the caller's name, callback number, and what "
    "they need so someone can call them back."
)


@dataclass
class TransferResult:
    """Structured result of a SIP transfer attempt.

    Returned by `Receptionist._execute_transfer`. The LLM `transfer_call`
    tool path returns `result.message` to the model. The DTMF handler
    (issue #16) branches on `result.status` to decide whether to record
    the transfer as executed, pivot to take_message, or surface a failure
    to the caller.
    """

    status: Literal[
        "transferred",
        "intake_only_refused",
        "department_not_found",
        "sip_api_failed",
    ]
    message: str
    target_name: Optional[str] = None


def _create_background_task(coro) -> asyncio.Task:
    task = asyncio.create_task(coro)
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)
    return task


def _tool_display_names(tools) -> list[str]:
    names: list[str] = []
    for tool in tools:
        info = getattr(tool, "info", None)
        name = getattr(info, "name", None) or getattr(tool, "id", None)
        if name:
            names.append(str(name))
    return names


def _agent_generation_matches_file() -> bool:
    expected = os.environ.get("RECEPTIONIST_AGENT_GENERATION")
    generation_file = os.environ.get("RECEPTIONIST_AGENT_GENERATION_FILE")
    if not expected or not generation_file:
        return True
    try:
        actual = Path(generation_file).read_text(encoding="utf-8").strip()
    except OSError:
        return False
    return actual == expected


def _check_generation_watchdog_once(*, exit_process=os._exit) -> bool:
    if _agent_generation_matches_file():
        return False
    logger.error(
        "Agent generation changed or disappeared; exiting stale worker",
        extra={"component": "agent.generation"},
    )
    exit_process(0)
    return True


def _generation_watchdog_loop(
    *, interval_seconds: float = _GENERATION_WATCHDOG_INTERVAL_SECONDS,
) -> None:
    while True:
        _check_generation_watchdog_once()
        time.sleep(interval_seconds)


def _start_generation_watchdog_once(
    *, interval_seconds: float = _GENERATION_WATCHDOG_INTERVAL_SECONDS,
    thread_factory=threading.Thread,
    exit_process=os._exit,
) -> threading.Thread | None:
    global _GENERATION_WATCHDOG_THREAD
    if not os.environ.get("RECEPTIONIST_AGENT_GENERATION"):
        return None
    if not os.environ.get("RECEPTIONIST_AGENT_GENERATION_FILE"):
        return None
    if _check_generation_watchdog_once(exit_process=exit_process):
        return None
    if _GENERATION_WATCHDOG_THREAD is not None and _GENERATION_WATCHDOG_THREAD.is_alive():
        return _GENERATION_WATCHDOG_THREAD
    _GENERATION_WATCHDOG_THREAD = thread_factory(
        target=lambda: _generation_watchdog_loop(interval_seconds=interval_seconds),
        name="receptionist-generation-watchdog",
        daemon=True,
    )
    _GENERATION_WATCHDOG_THREAD.start()
    logger.info(
        "Started agent generation watchdog",
        extra={"component": "agent.generation"},
    )
    return _GENERATION_WATCHDOG_THREAD


_WARMUP_TIMEOUT_SECONDS = 8.0


async def _warm_signaling(*, api_factory=None, timeout: float = _WARMUP_TIMEOUT_SECONDS) -> None:
    """Best-effort warm-up of the LiveKit connection inside a job-runner
    subprocess.

    Cold-start mitigation (handoff 2026-05-28): the first real call after a
    job-runner subprocess is spawned pays a 10-24s penalty in
    `session.start()` because LiveKit's signal client tries a legacy path
    first and times out before retrying, and DNS/TLS to the LiveKit host is
    cold. Issuing one cheap read-only RoomService call here warms DNS, the
    TLS session, and the aiohttp connection pool to the LiveKit API host in
    THIS subprocess before any caller is on the line.

    This is a PARTIAL mitigation: it cannot pre-open the per-room WebRTC
    signaling socket (no room exists at prewarm time), so it does not fully
    eliminate the v0-path timeout. It stacks with the Twilio failover
    origination URL; the definitive fix is moving the worker to a cloud VM in
    LiveKit's region.

    Never raises — a warmup failure (missing creds in a dev shell, transient
    network error, host down) must not stop the subprocess from serving
    calls. Failures log at WARNING with `component=agent.warmup` so a
    persistently-failing warmup is greppable.
    """
    if api_factory is None:
        api_factory = lambda: api.LiveKitAPI()  # noqa: E731 — reads LIVEKIT_* env
    client = None
    try:
        client = api_factory()
        await asyncio.wait_for(
            client.room.list_rooms(api.ListRoomsRequest()), timeout=timeout,
        )
        logger.info(
            "Signaling warmup completed",
            extra={"component": "agent.warmup"},
        )
    except Exception as e:  # noqa: BLE001 — warmup must never break startup
        logger.warning(
            "Signaling warmup failed (non-fatal): %s", e,
            extra={"component": "agent.warmup"},
        )
    finally:
        if client is not None:
            try:
                await client.aclose()
            except Exception:  # noqa: BLE001
                pass


def _prewarm(proc) -> None:
    """`server.setup_fnc` hook: runs once per job-runner subprocess before its
    first job. Drives the async signaling warmup to completion on a private
    event loop, fully best-effort — any failure is swallowed so the
    subprocess can still accept jobs.
    """
    try:
        asyncio.run(_warm_signaling())
    except Exception as e:  # noqa: BLE001 — prewarm must never raise
        logger.warning(
            "Prewarm hook failed (non-fatal): %s", e,
            extra={"component": "agent.warmup"},
        )


def _run_agent_cli() -> None:
    _start_generation_watchdog_once()
    agents.cli.run_app(server)


def _verify_tool_contract(receptionist, *, call_id: str) -> None:
    config = receptionist.config
    required: set[str] = set()
    intakes_cfg = getattr(config, "intakes", None)
    if intakes_cfg is not None and getattr(intakes_cfg, "enabled", False):
        required.update({"record_intake_answer", "finalize_intake"})
    packets_cfg = getattr(config, "info_packets", None)
    if packets_cfg is not None and getattr(packets_cfg, "enabled", False):
        required.add("send_info_packet")
    if not required:
        return

    available = set(_tool_display_names(receptionist.tools))
    missing = sorted(required - available)
    if not missing:
        return

    logger.error(
        "Receptionist tool contract missing required tools: %s",
        ", ".join(missing),
        extra={"call_id": call_id, "component": "agent.tools"},
    )
    raise RuntimeError(f"Receptionist missing required tools: {', '.join(missing)}")


def _attach_timing_log(session, call_id: str) -> None:
    """Log one TIMING line per reply: where the seconds go (speech-to-text wait,
    Gemini first word, voice first sound). Read with:  findstr TIMING agentlog.txt"""
    from livekit.agents import metrics as lk_metrics

    def _on_metrics(ev) -> None:
        m = getattr(ev, "metrics", None)
        try:
            if isinstance(m, lk_metrics.EOUMetrics):
                logger.info("TIMING caller-finished->text-ready %.2fs (end-of-speech wait %.2fs)",
                            m.transcription_delay, m.end_of_utterance_delay,
                            extra={"call_id": call_id, "component": "agent.timing"})
            elif isinstance(m, lk_metrics.LLMMetrics) and not m.cancelled:
                logger.info("TIMING gemini first-word %.2fs, full reply %.2fs, %d prompt tokens",
                            m.ttft, m.duration, m.prompt_tokens,
                            extra={"call_id": call_id, "component": "agent.timing"})
            elif isinstance(m, lk_metrics.TTSMetrics) and not m.cancelled:
                logger.info("TIMING voice first-sound %.2fs", m.ttfb,
                            extra={"call_id": call_id, "component": "agent.timing"})
        except Exception:
            pass

    session.on("metrics_collected", _on_metrics)


def _active_tools(receptionist):
    """Drop tools for features this business hasn't switched on.

    Every tool's description is sent to the AI on every turn, so unused
    tools make each request slower and give the model more ways to go wrong.
    """
    cfg = getattr(receptionist, "config", None)
    if cfg is None:
        return receptionist.tools
    calendar_on = bool(cfg.calendar and cfg.calendar.enabled)
    intakes_on = bool(cfg.intakes and getattr(cfg.intakes, "enabled", False))
    packets_on = bool(cfg.info_packets and getattr(cfg.info_packets, "enabled", False))
    drop = set()
    if not calendar_on:
        drop |= {"check_availability", "book_appointment", "find_my_appointment",
                 "cancel_appointment", "reschedule_appointment"}
    if not intakes_on:
        drop |= {"record_intake_answer", "finalize_intake", "await_keypad_entry"}
    if not packets_on:
        drop.add("send_info_packet")
    if not cfg.routing:
        drop.add("transfer_call")
    from receptionist.integrations.dashboard import dashboard_url
    if not dashboard_url():
        drop |= {"check_report_status", "check_opd_queue"}
    if not drop:
        return receptionist.tools
    keep = []
    for tool in receptionist.tools:
        names = _tool_display_names([tool])
        if not names or names[0] not in drop:
            keep.append(tool)
    return keep


async def _refresh_realtime_tools(receptionist, *, call_id: str) -> None:
    """Force-push the agent tool list into the active realtime session.

    LiveKit sends tools during activity startup, but observed live calls showed
    OpenAI returning function calls for intake tools that the runtime tool
    context did not know about. A post-start refresh is idempotent and gives
    the realtime session one more explicit `session.update` with the full tool
    list before caller turns begin.

    Failures (transport blips, OpenAI Realtime session not yet ready, etc.)
    are logged at ERROR with structured `component`/`phase`/`call_id` fields
    and then re-raised. Silent swallowing was the root cause of multiple
    live-call "Unknown function" regressions — the call now fails fast and
    LiveKit's job runner reports the underlying exception instead of letting
    the call proceed with a phantom tool registry.
    """
    tools = _active_tools(receptionist)
    tool_names = ", ".join(_tool_display_names(tools)) or "(none)"
    try:
        await receptionist.update_tools(tools)
    except Exception:
        logger.exception(
            "Failed to refresh realtime tool registry: %s",
            tool_names,
            extra={
                "call_id": call_id,
                "component": "agent.tools",
                "phase": "update_tools",
            },
        )
        raise
    logger.info(
        "Refreshed realtime tool registry: %s",
        tool_names,
        extra={"call_id": call_id, "component": "agent.tools"},
    )


def _is_benign_engine_closed_warning(record: logging.LogRecord) -> bool:
    return (
        record.levelno == logging.WARNING
        and record.getMessage().strip() == _BENIGN_ENGINE_CLOSED_MESSAGE
    )


class _PostCloseEngineWarningFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return not _is_benign_engine_closed_warning(record)


_post_close_engine_warning_filter = _PostCloseEngineWarningFilter()
for _logger_name in ("livekit", "livekit.agents", "livekit.plugins.openai"):
    logging.getLogger(_logger_name).addFilter(_post_close_engine_warning_filter)


def _resolve_agent_name() -> str:
    return os.environ.get("RECEPTIONIST_AGENT_NAME", DEFAULT_AGENT_NAME)


def _is_final_user_transcript(ev) -> bool:
    if not getattr(ev, "is_final", False):
        return False
    transcript = getattr(ev, "transcript", None)
    if transcript is None:
        return True
    return bool(str(transcript).strip())


def _format_friendly_date(dt: datetime) -> str:
    """Cross-platform 'Monday, April 28 at 2:00 PM'.

    Callers must pass a tz-aware datetime — the rendered time has no
    timezone marker, so a naive datetime would silently lose offset info.
    `find_slots` produces tz-aware iso strings, so `datetime.fromisoformat`
    of those is safe.
    """
    hour = dt.hour % 12 or 12
    return f"{dt.strftime('%A, %B')} {dt.day} at {hour}:{dt.strftime('%M %p')}"


# Light email-shape regex — exists to catch obvious caller mishearings ("dot calm",
# missing @, missing TLD). Google rejects malformed emails server-side too, this
# is just for a friendlier in-call error message.
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_SIP_PHONE_RE = re.compile(r"^\+?\d{7,15}$")
_SIP_URI_PHONE_RE = re.compile(
    r"(?:^|[<\s])sip:(\+?\d{7,15})(?:@|[>;\s]|$)", re.IGNORECASE,
)
_SIP_IDENTITY_PHONE_RE = re.compile(r"^sip_(\+?\d{7,15})$", re.IGNORECASE)


# Caps on caller-supplied free-text fields. The LLM faithfully passes through
# whatever the caller said, so without these caps a 30-minute rant becomes a
# 30,000-character "message" — which bloats storage, slows email rendering,
# and (for calendar event descriptions) hits Google's 8KB limit. Truncate +
# log rather than reject: the call should keep flowing; staff can read the
# log if they need the full version.
# RFC 5321 caps email addresses at 254 chars. The other limits are operator-
# friendly: room for a long name or a verbose voicemail without being a vector.
_TRUNCATE_LIMITS = {
    "caller_name": 200,
    "callback_number": 50,
    "message": 4000,
    "notes": 1000,
    "caller_email": 254,
    # Intake fields. spoken_text can be a longer answer (paragraph) so it
    # gets a more generous cap; english_summary is meant to be concise and
    # gets a tighter one to nudge the LLM toward brevity.
    "intake_spoken_text": 4000,
    "intake_english_summary": 2000,
    "intake_english_overview": 4000,
}


def _cap(field: str, value: str | None, *, call_id: str | None = None) -> str | None:
    """Truncate `value` to _TRUNCATE_LIMITS[field] chars, logging when it does.

    Returns None unchanged. Treats whitespace as content (the caller said it).
    """
    if value is None:
        return None
    limit = _TRUNCATE_LIMITS[field]
    if len(value) <= limit:
        return value
    extra = {"call_id": call_id, "component": "agent.input_caps"} if call_id else {}
    logger.info(
        "Truncated overlong %s: %d chars -> %d", field, len(value), limit,
        extra=extra,
    )
    return value[:limit]


_WEEKDAYS = {
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
    "friday": 4, "saturday": 5, "sunday": 6,
}


_INDIC_DIGITS = str.maketrans("০১২৩৪৫৬৭৮৯०१२३४५६७८९", "01234567890123456789")

# Day words in English, Hindi and Bengali (native script + romanised) -> days from today.
_DAY_WORDS = {
    0: ("today", "tonight", "aaj", "aj", "aajke", "ajke", "আজ", "আজকে", "आज"),
    1: ("tomorrow", "kal", "kaal", "kalke", "agamikal", "কাল", "কালকে", "আগামীকাল", "कल"),
    2: ("day after tomorrow", "parso", "parson", "porshu", "poshu", "porsu", "পরশু", "परसों", "परसो"),
}
# Part-of-day words -> a default clock time.
_PART_OF_DAY = (
    (("morning", "subah", "sakal", "sokal", "सुबह", "সকাল", "সকালে"), "10:00"),
    (("noon", "dopahar", "dupur", "दोपहर", "দুপুর", "দুপুরে"), "13:00"),
    (("afternoon", "bikel", "bikal", "বিকেল", "বিকালে", "বিকেলে"), "16:00"),
    (("evening", "shaam", "sham", "sondhya", "shondha", "शाम", "সন্ধ্যা", "সন্ধ্যায়"), "18:00"),
    (("night", "raat", "rat", "रात", "রাত", "রাতে"), "20:00"),
)


def _normalize_when(preferred_date: str, preferred_time: str, now: datetime) -> tuple[str, str]:
    """Turn Hindi/Bengali/English relative words into text dateutil understands.

    The model is asked to send ISO dates, but this is the safety net for
    "kal", "কাল সন্ধ্যায়", "tomorrow evening", Bengali/Devanagari digits, etc.
    """
    date_s = (preferred_date or "").translate(_INDIC_DIGITS).strip()
    time_s = (preferred_time or "").translate(_INDIC_DIGITS).strip()
    low_date, low_time = date_s.lower(), time_s.lower()
    for offset, words in sorted(_DAY_WORDS.items(), key=lambda kv: -kv[0]):
        if any(w == low_date or f" {w} " in f" {low_date} " for w in words):
            date_s = (now + timedelta(days=offset)).strftime("%B %d %Y")
            break
    if any(ch.isdigit() for ch in time_s) and not time_s.isascii():
        # e.g. "5টা", "5 बजे": keep the clock number; 1-7 o'clock means PM in a clinic.
        m = re.search(r"(\d{1,2})(?::(\d{2}))?", time_s)
        if m:
            hour, minute = int(m.group(1)), int(m.group(2) or 0)
            if 1 <= hour <= 7:
                hour += 12
            time_s = f"{hour:02d}:{minute:02d}"
    if not any(ch.isdigit() for ch in low_time):
        for words, clock in _PART_OF_DAY:
            if any(w in low_time or w in low_date for w in words):
                time_s = clock
                break
        else:
            if not low_time:
                time_s = "11:00"
    return date_s, time_s


def _resolve_relative_date(preferred_date: str, now: datetime) -> str:
    """Convert relative-date phrases into absolute dates dateutil can parse.

    Handles: "today" / "tonight", "tomorrow", "next <weekday>", "this <weekday>".
    Falls through unchanged for absolute dates ("April 28") and bare weekday
    names ("Monday") — dateutil handles those.
    """
    s = preferred_date.strip().lower()
    if s in {"today", "tonight"}:
        return now.strftime("%B %d %Y")
    if s == "tomorrow":
        return (now + timedelta(days=1)).strftime("%B %d %Y")

    # "next Monday" → 7+ days out; "this Monday" → soonest occurrence (today counts)
    for prefix in ("next ", "this "):
        if s.startswith(prefix):
            wd = s[len(prefix):]
            if wd in _WEEKDAYS:
                target = _WEEKDAYS[wd]
                days_ahead = (target - now.weekday()) % 7
                if prefix == "next " and days_ahead < 7:
                    days_ahead += 7
                target_dt = now + timedelta(days=days_ahead)
                return target_dt.strftime("%B %d %Y")

    return preferred_date


def load_business_config(ctx: agents.JobContext) -> BusinessConfig:
    """Load business config based on job metadata or default to first config found."""
    metadata = {}
    if ctx.job.metadata:
        try:
            metadata = json.loads(ctx.job.metadata)
        except json.JSONDecodeError:
            logger.warning("Failed to parse job metadata as JSON")

    config_name = metadata.get("config", None) or os.environ.get("RECEPTIONIST_CONFIG")

    if config_name:
        if not re.match(r"^[a-zA-Z0-9_-]+$", config_name):
            raise ValueError(f"Invalid config name: {config_name!r}")
        config_path = DEFAULT_CONFIG_DIR / f"{config_name}.yaml"
    else:
        yaml_files = sorted(DEFAULT_CONFIG_DIR.glob("*.yaml"))
        if not yaml_files:
            raise FileNotFoundError(f"No config files found in {DEFAULT_CONFIG_DIR}")
        config_path = yaml_files[0]
        logger.info(f"No config specified, using: {config_path.name}")

    return load_config(config_path)


def _get_caller_identity(ctx: agents.JobContext) -> str:
    """Get the SIP caller's participant identity from the room.

    Prefers participants whose kind is `PARTICIPANT_KIND_SIP`, but falls back
    to any participant whose identity matches `sip_<digits>` so BYOC/Asterisk
    trunks that publish a different kind value still work.
    """
    fallback = ""
    for participant in ctx.room.remote_participants.values():
        if participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_SIP:
            return participant.identity
        identity = getattr(participant, "identity", "")
        if identity and _SIP_IDENTITY_PHONE_RE.fullmatch(identity.strip()):
            fallback = fallback or identity
    if fallback:
        return fallback
    logger.warning("No SIP participant found in room %s", ctx.room.name)
    return ""


def _get_caller_phone(ctx: agents.JobContext) -> str | None:
    """Best-effort extract caller phone number from any room participant."""
    for participant in ctx.room.remote_participants.values():
        phone = _get_sip_participant_phone(participant)
        if phone:
            return phone
    return None


def _get_sip_participant_phone(participant: rtc.RemoteParticipant) -> str | None:
    """Resolve a phone number for `participant`, kind-agnostic.

    Order of attempts:
      1. SIP attribute `sip.phoneNumber` (LiveKit Cloud + most BYOC trunks)
      2. SIP attribute `sip.fromUser` (some Telnyx setups)
      3. SIP attribute `sip.from` URI / FROM-header value
      4. Participant identity matching `sip_<digits>` (Asterisk BYOC pattern)

    The kind gate was removed in 2026-05 because some BYOC/Asterisk trunks
    emit the SIP participant with a non-SIP kind value, but its identity
    still matches `sip_<digits>`. The identity regex is specific enough
    that false positives from non-SIP participants are not a real risk.
    """
    attrs = getattr(participant, "attributes", {}) or {}
    phone = attrs.get("sip.phoneNumber")
    if phone:
        return phone
    for attr_name in ("sip.fromUser", "sip.from"):
        phone = _normalize_sip_phone(attrs.get(attr_name))
        if phone:
            return phone
    return _get_sip_phone_from_identity(getattr(participant, "identity", ""))


def _normalize_sip_phone(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip()
    if _SIP_PHONE_RE.fullmatch(value):
        return value if value.startswith("+") else f"+{value}"
    match = _SIP_URI_PHONE_RE.search(value)
    if match:
        phone = match.group(1)
        return phone if phone.startswith("+") else f"+{phone}"
    return None


def _get_sip_phone_from_identity(identity: str) -> str | None:
    match = _SIP_IDENTITY_PHONE_RE.fullmatch(identity.strip())
    if not match:
        return None
    phone = match.group(1)
    return phone if phone.startswith("+") else f"+{phone}"


# Whitelist of reasons accepted by `end_call`. Keeps the agent-end reason
# field (CallMetadata.agent_end_reason) bounded to known causes so dashboards
# and call-summary email subjects stay consistent. New causes added here must
# also be reflected in documentation/function-tools-reference.md.
_AGENT_END_REASONS = frozenset(
    {
        "caller_goodbye",
        "silence_timeout",
        "unproductive_turns_exhausted",
        "max_duration_reached",
    }
)


# Default goodbye instructions per agent-end reason. The end_call tool can
# override these, but the silence/duration/unproductive paths use these so
# the caller hears something appropriate rather than a generic "bye".
_AGENT_END_INSTRUCTIONS = {
    "caller_goodbye": (
        "Say a very brief, friendly goodbye to the caller in one short "
        "sentence (e.g. \"Thanks for calling, have a great day!\"). Do not "
        "add follow-up questions; the call ends right after."
    ),
    "silence_timeout": (
        "The caller has gone quiet. Say a brief, friendly note that you "
        "are wrapping up because you haven't heard from them, and invite "
        "them to call back any time. One or two short sentences only."
    ),
    "unproductive_turns_exhausted": (
        "Politely close the call: acknowledge that you have not been able "
        "to help with this request, suggest the caller contact the office "
        "directly during business hours, and say goodbye. One or two short "
        "sentences only."
    ),
    "max_duration_reached": (
        "Politely note that the call has run long and you need to wrap up, "
        "invite the caller to call back any time, and say goodbye. One or "
        "two short sentences only."
    ),
}


def _extract_message_text(item) -> str:
    """Best-effort flatten an `llm.ChatMessage`-shaped item into a plain string.

    The realtime SDK exposes `item.content` as either a string or a list of
    content parts (each part has `.text` for text parts, `.transcript` for
    audio transcripts). We concatenate everything string-like and ignore the
    rest.
    """
    content = getattr(item, "content", None)
    if isinstance(content, str):
        return content
    if not content:
        return ""
    parts: list[str] = []
    for part in content:
        if isinstance(part, str):
            parts.append(part)
            continue
        text = getattr(part, "text", None)
        if isinstance(text, str):
            parts.append(text)
            continue
        transcript = getattr(part, "transcript", None)
        if isinstance(transcript, str):
            parts.append(transcript)
    return " ".join(parts).strip()


async def _speak_goodbye_and_terminate(
    session: AgentSession,
    lifecycle: CallLifecycle,
    job_ctx: agents.JobContext,
    *,
    reason: str,
) -> None:
    """Speak a brief goodbye then disconnect the SIP caller.

    Used by `Receptionist.end_call` (caller said goodbye) and the
    silence/duration/unproductive watchers in `handle_call`. Each call site
    is expected to have already called `lifecycle.record_agent_ended(reason)`
    synchronously, so the call summary reflects the agent end even if the
    natural-disconnect close event races this background task.

    The goodbye playout uses a hard 10s timeout so a stuck TTS never wedges
    the call open. Terminate then prefers SIP BYE via `remove_participant`
    and falls back to `delete_room` (see `_terminate_room`).
    """
    call_id = lifecycle.metadata.call_id
    log_extra = {"call_id": call_id, "component": "agent.end"}
    instructions = _AGENT_END_INSTRUCTIONS.get(
        reason, _AGENT_END_INSTRUCTIONS["caller_goodbye"],
    )

    handle = None
    if session is not None:
        try:
            handle = session.generate_reply(instructions=instructions)
        except Exception:
            logger.exception(
                "agent_end: failed to speak goodbye (reason=%s); proceeding "
                "to terminate", reason, extra=log_extra,
            )

    # Order: wait for goodbye playout -> drop the SIP caller -> finalize
    # (transcript + email fan-out, which now includes the up-to-20s AI
    # summary). Releasing the caller BEFORE the email work means they hear the
    # goodbye and the line drops immediately, instead of sitting on a live
    # line for the duration of summary generation. This is safe because:
    #   - remove_participant (SIP BYE) drops only the caller; the agent's own
    #     job process stays alive, so the asyncio executor is still healthy for
    #     the email DNS/SMTP work that runs in on_call_ended.
    #   - on_call_ended is idempotent (the session-close handler calls it too;
    #     the second call is a guarded no-op), so finalization runs exactly
    #     once regardless of which path reaches it first.
    if handle is not None:
        try:
            await asyncio.wait_for(handle.wait_for_playout(), timeout=10.0)
        except asyncio.TimeoutError:
            logger.warning(
                "agent_end: goodbye playout timed out (reason=%s)",
                reason, extra=log_extra,
            )
        except Exception:
            logger.exception(
                "agent_end: error waiting for goodbye playout (reason=%s)",
                reason, extra=log_extra,
            )

    caller_identity = _get_caller_identity(job_ctx)
    try:
        await _terminate_room(
            job_ctx, caller_identity, job_ctx.room.name, call_id=call_id,
        )
    except Exception:
        # Never let a terminate failure skip the email fan-out — losing the
        # call-summary email is worse than a messy hangup.
        logger.exception(
            "agent_end: terminate raised; finalizing lifecycle anyway",
            extra=log_extra,
        )

    logger.info(
        "agent_end: invoking lifecycle.on_call_ended post-terminate "
        "(pending=%d, channels=%d)",
        len(lifecycle._pending_message_emails),
        len(lifecycle._email_channels),
        extra=log_extra,
    )
    try:
        await lifecycle.on_call_ended()
        logger.info(
            "agent_end: lifecycle.on_call_ended returned cleanly",
            extra=log_extra,
        )
    except Exception:
        logger.exception(
            "agent_end: lifecycle.on_call_ended raised",
            extra=log_extra,
        )


async def _terminate_room(
    job_ctx: agents.JobContext,
    caller_identity: str,
    room_name: str,
    *,
    call_id: str,
) -> None:
    """Disconnect the caller; prefer SIP BYE, fall back to full room delete.

    `remove_participant` is the right tool for SIP BYE: it asks LiveKit to
    drop the caller specifically (the agent stays in the room until the
    session close handler fires). If that call fails — typically because
    the agent token lacks `room_admin` for this room, or the participant
    has already disconnected — we fall back to `delete_room`, which closes
    the room for everyone and triggers the participant-disconnect close
    path. Either way, the close handler runs `lifecycle.on_call_ended`.
    """
    log_extra = {"call_id": call_id, "component": "agent.terminate"}
    if caller_identity:
        try:
            await asyncio.wait_for(
                job_ctx.api.room.remove_participant(
                    api.RoomParticipantIdentity(
                        room=room_name, identity=caller_identity,
                    )
                ),
                timeout=_LIVEKIT_OPERATION_TIMEOUT_SECONDS,
            )
            logger.info(
                "end_call: removed participant %s from %s",
                caller_identity, room_name, extra=log_extra,
            )
            return
        except Exception:
            logger.warning(
                "end_call: remove_participant failed for %s in %s; "
                "falling back to delete_room",
                caller_identity, room_name, exc_info=True, extra=log_extra,
            )
    try:
        await asyncio.wait_for(
            job_ctx.api.room.delete_room(
                api.DeleteRoomRequest(room=room_name)
            ),
            timeout=_LIVEKIT_OPERATION_TIMEOUT_SECONDS,
        )
        logger.info("end_call: deleted room %s", room_name, extra=log_extra)
    except Exception:
        logger.exception(
            "end_call: delete_room failed for %s; close event will fire on "
            "natural disconnect",
            room_name, extra=log_extra,
        )


def _capture_caller_phone_from_participant(
    lifecycle: CallLifecycle, participant: rtc.RemoteParticipant,
    *, source: str = "snapshot",
) -> None:
    """Set caller_phone from a participant if not yet known.

    Always-on INFO logs (component=`agent.callerid`) record both the
    successful capture path and the negative result so on-call operators
    can diagnose CallerID issues without flipping debug flags. The
    participant identity is logged so BYOC/Asterisk trunks emitting
    `sip_<digits>` are visible in production logs.
    """
    phone = _get_sip_participant_phone(participant)
    identity = getattr(participant, "identity", "") or ""
    kind = getattr(participant, "kind", None)
    extra = {
        "call_id": lifecycle.metadata.call_id,
        "component": "agent.callerid",
        "source": source,
        "participant_identity": identity,
        "participant_kind": int(kind) if kind is not None else None,
    }
    if phone:
        already_set = lifecycle.metadata.caller_phone is not None
        lifecycle.set_caller_phone(phone)
        if already_set:
            logger.info(
                "callerid: phone already captured; new candidate ignored",
                extra=extra,
            )
        else:
            logger.info("callerid: captured caller phone", extra=extra)
        return
    logger.info(
        "callerid: no phone resolvable from participant identity=%r attrs_keys=%s",
        identity,
        sorted((getattr(participant, "attributes", {}) or {}).keys()),
        extra=extra,
    )


_DTMF_DEBOUNCE_SECONDS = 1.5

_KEYPAD_ENTRY_TIMEOUT_SECONDS = 30.0

_KEYPAD_VOICE_FALLBACK = (
    "Keypad entry isn't available right now. Ask the caller to say the number "
    "instead, then read it back digit by digit and confirm before recording it."
)

_DTMF_TAKE_MESSAGE_INSTRUCTIONS = (
    "Briefly acknowledge that you will take a message. Then ask "
    "for the caller's name, their callback number, and what they "
    "need. Then call take_message with that information."
)


@dataclass
class _ActiveCapture:
    """A live keypad-digit capture armed by the await_keypad_entry tool.

    `future` is resolved with the captured digit string when the caller
    presses # or reaches the expected length. `question_key` is for logging.
    """
    buffer: DigitCaptureBuffer
    future: "asyncio.Future"
    question_key: str


@dataclass
class _DtmfHandlerState:
    """Per-call state the DTMF handler closes over.

    `execute_transfer` is `Receptionist._execute_transfer` (async; takes a
    department-name string and `source=`, returns a `TransferResult`).
    `speak_goodbye` is an async no-arg callable that finalizes the call and
    disconnects the SIP caller. `clock` is injectable so debounce tests are
    not time-flaky.
    """

    config: BusinessConfig
    lifecycle: CallLifecycle
    session: AgentSession
    sip_caller_identity: str | None
    execute_transfer: object        # async (department: str, *, source) -> TransferResult
    speak_goodbye: object           # async () -> None
    clock: object = time.monotonic  # injectable for tests

    last_press_ts: dict[str, float] = field(default_factory=dict)
    action_in_flight: bool = False
    # Set by await_keypad_entry while collecting digits for an intake answer.
    capture: _ActiveCapture | None = None


async def _dispatch_dtmf_event(event, state: _DtmfHandlerState) -> None:
    """Process a single `sip_dtmf_received` event.

    Keypad presses are a deterministic side channel — they do NOT go through
    the LLM. The digit→action mapping comes from `dtmf.digits`; this handler
    debounces rapid repeats, suppresses presses while an action is in flight,
    speaks a brief acknowledgment, then dispatches the configured action.
    Transfers reuse `Receptionist._execute_transfer`, so the `intake_only`
    gate and the SIP API path live in exactly one place.

    Errors during acknowledgment or dispatch are logged and swallowed so a
    misbehaving keypress never crashes the call.
    """
    dtmf_cfg = state.config.dtmf
    menu_enabled = dtmf_cfg is not None and dtmf_cfg.enabled
    # Bail only when there's nothing to do with the keypress: no menu AND no
    # armed capture. An armed capture (Task 5) routes digits even when the
    # business config has no `dtmf` menu block.
    if not menu_enabled and state.capture is None:
        return

    participant_identity = getattr(getattr(event, "participant", None), "identity", None)
    if state.sip_caller_identity and participant_identity != state.sip_caller_identity:
        logger.info(
            "dtmf: ignoring event from non-SIP-caller participant %s",
            participant_identity,
            extra={
                "call_id": state.lifecycle.metadata.call_id,
                "component": "agent.dtmf",
                "digit": getattr(event, "digit", None),
            },
        )
        return

    digit = str(getattr(event, "digit", "")).strip()

    if state.capture is not None:
        _feed_capture_digit(state, digit)
        return

    action_cfg = dtmf_cfg.digits.get(digit) if dtmf_cfg is not None else None

    if action_cfg is None:
        state.lifecycle.record_dtmf_event(
            digit=digit, action=None, target=None, status="unmapped",
        )
        logger.info(
            "dtmf: unmapped digit %r ignored", digit,
            extra={
                "call_id": state.lifecycle.metadata.call_id,
                "component": "agent.dtmf",
            },
        )
        return

    now = state.clock()
    last_ts = state.last_press_ts.get(digit)
    if last_ts is not None and (now - last_ts) < _DTMF_DEBOUNCE_SECONDS:
        state.lifecycle.record_dtmf_event(
            digit=digit, action=action_cfg.action, target=action_cfg.routing,
            status="duplicate_ignored",
        )
        return
    state.last_press_ts[digit] = now

    if state.action_in_flight:
        state.lifecycle.record_dtmf_event(
            digit=digit, action=action_cfg.action, target=action_cfg.routing,
            status="suppressed_in_flight",
        )
        return

    event_id = state.lifecycle.record_dtmf_event(
        digit=digit, action=action_cfg.action, target=action_cfg.routing,
        status="pending",
    )

    state.action_in_flight = True
    try:
        try:
            state.session.interrupt()
        except Exception:  # noqa: BLE001
            logger.warning(
                "dtmf: session.interrupt() raised; continuing",
                extra={
                    "call_id": state.lifecycle.metadata.call_id,
                    "component": "agent.dtmf",
                },
            )

        try:
            await state.session.generate_reply(
                instructions=f"Say briefly, verbatim: '{action_cfg.acknowledgment_en}'",
            )
        except Exception:  # noqa: BLE001
            logger.warning(
                "dtmf: acknowledgment generate_reply raised; continuing",
                extra={
                    "call_id": state.lifecycle.metadata.call_id,
                    "component": "agent.dtmf",
                },
            )

        if action_cfg.action == "transfer":
            # _execute_transfer owns the routing lookup (and emits
            # department_not_found if the entry is gone), so pass the name.
            result = await state.execute_transfer(
                action_cfg.routing, source="dtmf",
            )
            if result.status == "transferred":
                state.lifecycle.update_dtmf_event_status(event_id, status="executed")
            elif result.status == "intake_only_refused":
                state.lifecycle.update_dtmf_event_status(
                    event_id, status="refused_intake_only",
                )
                await state.session.generate_reply(
                    instructions=(
                        "Say: 'This line cannot transfer calls, but I can take a "
                        "message and have someone call you back.' Then ask for "
                        "the caller's name, callback number, and what they need. "
                        "Then call take_message."
                    ),
                )
            else:
                # sip_api_failed or department_not_found — surface a graceful
                # fallback to take_message either way.
                state.lifecycle.update_dtmf_event_status(
                    event_id, status="failed", error=result.status,
                )
                await state.session.generate_reply(
                    instructions=(
                        "Say: 'I'm having trouble transferring that call. Let me "
                        "take a message instead.' Then ask for the caller's name, "
                        "callback number, and what they need. Then call take_message."
                    ),
                )
        elif action_cfg.action == "take_message":
            await state.session.generate_reply(
                instructions=_DTMF_TAKE_MESSAGE_INSTRUCTIONS,
            )
            state.lifecycle.update_dtmf_event_status(event_id, status="executed")
        elif action_cfg.action == "end_call":
            await state.speak_goodbye()
            state.lifecycle.update_dtmf_event_status(event_id, status="executed")
        elif action_cfg.action == "repeat_menu":
            menu = state.config.dtmf.menu_announcement_en or ""
            await state.session.generate_reply(
                instructions=f"Say verbatim: '{menu}'",
            )
            state.lifecycle.update_dtmf_event_status(event_id, status="executed")
        else:
            state.lifecycle.update_dtmf_event_status(
                event_id, status="failed", error="unknown_action",
            )
    finally:
        state.action_in_flight = False


def _feed_capture_digit(state: _DtmfHandlerState, digit: str) -> None:
    """Route a keypad digit into the armed capture buffer.

    Resolves the capture Future on completion and disarms; logs clears. Never
    raises — a misbehaving keypress must not crash the call.
    """
    capture = state.capture
    if capture is None:
        return
    try:
        status = capture.buffer.add_key(digit)
    except Exception:
        logger.exception(
            "dtmf capture: add_key raised; ignoring digit",
            extra={
                "call_id": state.lifecycle.metadata.call_id,
                "component": "agent.dtmf_capture",
            },
        )
        return
    if status == CaptureStatus.COMPLETE:
        state.lifecycle.record_dtmf_event(
            digit=digit, action="intake_capture",
            target=capture.question_key, status="intake_capture",
        )
        state.capture = None
        if not capture.future.done():
            capture.future.set_result(capture.buffer.digits)
    elif status == CaptureStatus.CLEARED:
        state.lifecycle.record_dtmf_event(
            digit=digit, action="intake_capture",
            target=capture.question_key, status="intake_capture_cleared",
        )


class Receptionist(Agent):
    def __init__(self, config: BusinessConfig, lifecycle: CallLifecycle) -> None:
        super().__init__(instructions=build_system_prompt(config))
        self.config = config
        self.lifecycle = lifecycle
        # Session-scoped cache of slot ISO strings offered to the caller via
        # check_availability. book_appointment rejects any proposed_start_iso
        # that isn't in this set — prevents the LLM from hallucinating times.
        # Capped to the last N=3 check_availability calls so a long, chatty
        # call can't grow the set unbounded. 3 batches × ~3 slots = ~9 ISO
        # strings; the LLM only ever needs the most recent batch anyway.
        self._offered_slot_batches: deque[frozenset[str]] = deque(maxlen=3)
        # Lazily-constructed on first calendar tool call; reused for the rest
        # of the call so we don't pay Google's auth cost per tool invocation.
        self._calendar_client = None
        # Appointments found by find_my_appointment this call: event_id -> ExistingAppointment.
        # cancel/reschedule only act on IDs in here (no guessed or foreign IDs).
        self._found_appointments: dict = {}
        # Which doctor each offered slot belongs to (iso -> doctor name).
        self._slot_doctor: dict[str, str] = {}
        # Pre-build a single Dispatcher for the call. The constructor runs a
        # filesystem-walk in resolve_failures_dir(), so reusing it across
        # take_message invocations matters when callers leave several messages.
        self._dispatcher = Dispatcher(
            channels=self.config.messages.channels,
            business_name=self.config.business.name,
            email_config=self.config.email,
        )
        # Dict-backed routing lookup. transfer_call uses case-insensitive
        # exact match on the department name, so a dict is a clean fit.
        # NOTE: FAQ matching is bidirectional substring (caller "hours" can
        # match FAQ "What are your hours?" AND vice versa), which a single
        # dict can't represent — leave that as a linear scan.
        self._routing_by_name = {r.name.lower(): r for r in self.config.routing}
        # Issue #11 unproductive-turn counter state. See
        # _on_user_input_transcribed / _on_function_tools_executed /
        # _on_conversation_item_added for the full state machine.
        self._consecutive_unproductive_turns: int = 0
        self._current_turn_has_user_input: bool = False
        self._current_turn_used_tool: bool = False
        self._current_turn_assistant_replied: bool = False
        self._unproductive_end_scheduled: bool = False
        # Intake state. Populated by `record_intake_answer` and consumed by
        # `finalize_intake`. `_intake_answers` is keyed by question_key so
        # the LLM can re-record an answer (e.g. caller corrects themselves)
        # and the latest value wins. Stays empty if the caller never starts
        # an intake.
        from receptionist.intakes.models import IntakeAnswer
        self._IntakeAnswer = IntakeAnswer  # cached import for tool hot path
        self._intake_answers: dict[str, IntakeAnswer] = {}
        self._intake_case_type: str | None = None
        self._intake_language: str = "en"
        self._intake_started_at: str | None = None
        # Info-packet destination gate (mirrors the _offered_slot_batches
        # check-before-book pattern): send_info_packet refuses to send until
        # the model has been handed this exact address to read back and the
        # caller confirmed it. Holds the lowercased pending address.
        #
        # Consent is captured on the FIRST call (which requires
        # consent_confirmed=true to reach the read-back), so the confirming
        # SECOND call does not need to re-pass consent_confirmed — the model
        # only re-asserts destination_confirmed=true per the read-back
        # instruction. _pending_packet_destination being set IS the proof that
        # consent was already given for that address.
        self._pending_packet_destination: str | None = None
        # Shared DTMF handler state, assigned by handle_call after both the
        # Receptionist and the handler state exist. None when no DTMF listener
        # is wired. The await_keypad_entry tool arms a capture on this state.
        self._dtmf_state = None

    def _get_calendar_client(self):
        """Lazily construct and cache the Google Calendar client for this call."""
        if self._calendar_client is None:
            if self.config.calendar is None or not self.config.calendar.enabled:
                raise RuntimeError(
                    "Calendar tools were called but config.calendar is not enabled."
                )
            from receptionist.booking.auth import build_credentials
            from receptionist.booking.client import GoogleCalendarClient
            creds = build_credentials(self.config.calendar.auth)
            self._calendar_client = GoogleCalendarClient(
                creds, calendar_id=self.config.calendar.calendar_id,
            )
        return self._calendar_client

    async def _get_calendar_client_async(self):
        return await asyncio.to_thread(self._get_calendar_client)

    # ---- doctors ----
    def _active_doctors(self):
        return [d for d in (self.config.doctors or []) if d.active]

    def _resolve_doctor(self, name: str | None):
        """Return (DoctorConfig, None) or (None, message for the LLM)."""
        from receptionist.booking.booking import normalize_doctor
        docs = self._active_doctors()
        if not docs:
            return None, None
        if not name or not str(name).strip():
            if len(docs) == 1:
                return docs[0], None
            options = "; ".join(f"{d.name}" + (f" ({d.specialty})" if d.specialty else "") for d in docs)
            return None, (f"Ask the caller which doctor they want to see: {options}. "
                          "If they're unsure, suggest one by specialty from what they "
                          "describe (never diagnose), then call check_availability again "
                          "with the doctor's name.")
        key = normalize_doctor(name)
        exact = [d for d in docs if normalize_doctor(d.name) == key]
        partial = exact or [d for d in docs if key and (key in normalize_doctor(d.name) or normalize_doctor(d.name) in key)]
        if len(partial) == 1:
            return partial[0], None
        options = ", ".join(d.name for d in docs)
        return None, f"I couldn't match the doctor '{name}'. Available doctors: {options}. Ask the caller to pick one."

    def _hours_for(self, doc):
        return doc.hours if (doc is not None and doc.hours is not None) else self.config.hours

    def _calendar_for(self, doc):
        cal = self.config.calendar
        if doc is not None and doc.slot_minutes:
            return cal.model_copy(update={"appointment_duration_minutes": doc.slot_minutes})
        return cal

    async def _doctor_busy(self, client, doc, start, end, ignore_event_id=None):
        from receptionist.booking.booking import doctor_busy_intervals, leave_intervals
        events = await client.list_events(start - timedelta(hours=12), end)
        busy = doctor_busy_intervals(events, doc.name, ignore_event_id=ignore_event_id)
        busy += leave_intervals(doc.leave_dates, ZoneInfo(self.config.business.timezone))
        return busy

    async def _doctor_is_busy(self, client, doc, start, end, ignore_event_id=None) -> bool:
        busy = await self._doctor_busy(client, doc, start, end, ignore_event_id=ignore_event_id)
        return any(b_start < end and b_end > start for b_start, b_end in busy)

    async def _token_for(self, client, doc, start, ignore_event_id=None) -> int:
        from receptionist.booking.booking import next_token
        tz = ZoneInfo(self.config.business.timezone)
        local = start.astimezone(tz)
        day_start = local.replace(hour=0, minute=0, second=0, microsecond=0)
        day_end = day_start + timedelta(days=1)
        events = await client.list_events(day_start, day_end)
        return next_token(events, doc.name, day_start, day_end, ignore_event_id=ignore_event_id)

    def _record_offered_slots(self, iso_strings) -> None:
        """Add a batch of slot ISO strings to the bounded offer cache.

        Older batches age out automatically (deque maxlen=3).
        """
        self._offered_slot_batches.append(frozenset(iso_strings))

    def _slot_was_offered(self, iso: str) -> bool:
        """True if `iso` was offered in any of the last N batches."""
        return any(iso in batch for batch in self._offered_slot_batches)

    def _reset_offered_slots(self, iso_strings) -> None:
        """Clear the offer cache and seed it with this batch (used after race recovery)."""
        self._offered_slot_batches.clear()
        self._record_offered_slots(iso_strings)

    async def on_enter(self) -> None:
        # If recording is enabled with a consent preamble, speak the preamble
        # FIRST so the caller is notified before the greeting (design §4.2 —
        # two-party consent jurisdictions).
        recording = self.config.recording
        if (
            recording is not None
            and recording.enabled
            and recording.consent_preamble.enabled
        ):
            # Use triple quotes so apostrophes/quotes inside the preamble
            # text don't break the surrounding f-string delimiter.
            preamble_text = recording.consent_preamble.text
            await self.session.generate_reply(
                instructions=f"""Say exactly this, verbatim, before anything else:
{preamble_text}"""
            )

        greeting_text = self.config.greeting
        voice_cfg = self.config.voice
        has_tts = voice_cfg.engine == "pipeline" or (
            voice_cfg.engine == "gemini_live" and voice_cfg.live.voice_provider == "sarvam")
        if has_tts:
            # Text-to-speech the fixed greeting straight away: no AI round-trip,
            # so the caller hears it within about a second of connecting.
            self.session.say(greeting_text, allow_interruptions=True)
            return
        await self.session.generate_reply(
            instructions=f"""Greet the caller with:
{greeting_text}"""
        )

    @function_tool()
    async def lookup_faq(self, ctx: RunContext, question: str) -> str:
        """Look up the answer to a frequently asked question about the business."""
        for faq in self.config.faqs:
            if question.lower() in faq.question.lower() or faq.question.lower() in question.lower():
                self.lifecycle.record_faq_answered(faq.question)
                return faq.answer
        return "No exact FAQ match found. Use your knowledge from the system prompt to answer."

    @function_tool()
    async def transfer_call(self, ctx: RunContext, department: str) -> str:
        """Transfer the caller to a specific department or person."""
        result = await self._execute_transfer(department, source="tool", ctx=ctx)
        return result.message

    async def _execute_transfer(
        self,
        department: str,
        *,
        source: str,
        ctx: RunContext | None = None,
    ) -> TransferResult:
        """Shared SIP transfer logic for the `transfer_call` tool and DTMF.

        Owns the full transfer decision so both entry points get identical
        behavior and a structured result: the intake_only refusal gate, the
        routing lookup (emitting `department_not_found` when unmapped), the
        spoken tool-path acknowledgment, and the SIP API call itself.

        `source` is "tool" when invoked by the LLM tool path and "dtmf" when
        invoked by the keypad handler (issue #16). The DTMF handler branches
        on `TransferResult.status` to record/pivot/surface, so every failure
        mode here is a distinct status rather than a bare message string.

        For source="tool", we speak the existing "Tell the caller you're
        transferring them to {target.name} now." line via the supplied
        RunContext's session. For source="dtmf", the handler speaks its
        own acknowledgment from the configured DTMF acknowledgment string,
        so this helper skips that spoken line.
        """
        # intake_only refuses regardless of whether the requested department
        # exists — historical contract, and the DTMF path inherits it here.
        if self.config.agent.mode == "intake_only":
            return TransferResult(
                status="intake_only_refused",
                message=_INTAKE_ONLY_TRANSFER_REFUSAL,
                target_name=None,
            )

        target = self._routing_by_name.get(department.lower())
        if target is None:
            available = ", ".join(e.name for e in self.config.routing)
            return TransferResult(
                status="department_not_found",
                message=(
                    f"Department '{department}' not found. "
                    f"Available departments: {available}"
                ),
                target_name=None,
            )

        # Preserve historical tool-path behavior: speak "Tell the caller
        # you're transferring..." before the SIP API call. DTMF speaks its
        # own acknowledgment from the handler, so skip for source="dtmf".
        if source == "tool" and ctx is not None:
            try:
                await ctx.session.generate_reply(
                    instructions=(
                        f"Tell the caller you're transferring them to "
                        f"{target.name} now."
                    )
                )
            except Exception:  # noqa: BLE001 — best-effort acknowledgment
                logger.warning(
                    "transfer_call: tool-path acknowledgment failed; proceeding",
                    extra={
                        "call_id": self.lifecycle.metadata.call_id,
                        "component": "agent.transfer",
                    },
                )

        job_ctx = get_job_context()
        try:
            await asyncio.wait_for(
                job_ctx.api.sip.transfer_sip_participant(
                    api.TransferSIPParticipantRequest(
                        room_name=job_ctx.room.name,
                        participant_identity=_get_caller_identity(job_ctx),
                        transfer_to=self.config.sip.transfer_uri_template.format(
                            number=target.number,
                        ),
                    )
                ),
                timeout=_LIVEKIT_OPERATION_TIMEOUT_SECONDS,
            )
            self.lifecycle.record_transfer(target.name)
            return TransferResult(
                status="transferred",
                message=f"Call transferred to {target.name}",
                target_name=target.name,
            )
        except Exception as e:
            logger.error(
                "Failed to transfer call to %s: %s", target.name, e,
                extra={
                    "call_id": self.lifecycle.metadata.call_id,
                    "component": "agent.transfer",
                    "source": source,
                },
            )
            return TransferResult(
                status="sip_api_failed",
                message=(
                    f"Sorry, I wasn't able to transfer the call to "
                    f"{target.name}. Please ask the caller to try calling "
                    f"directly."
                ),
                target_name=target.name,
            )

    @function_tool()
    async def take_message(
        self, ctx: RunContext, caller_name: str, message: str, callback_number: str
    ) -> str:
        """Take a message from the caller."""
        call_id = self.lifecycle.metadata.call_id
        caller_name = _cap("caller_name", caller_name, call_id=call_id) or ""
        message = _cap("message", message, call_id=call_id) or ""
        callback_number = _cap("callback_number", callback_number, call_id=call_id) or ""
        msg = Message(
            caller_name=caller_name,
            callback_number=callback_number,
            message=message,
            business_name=self.config.business.name,
        )
        try:
            # Email portion is deferred to call-end so the message email can
            # attach the full transcript as a .txt file (which doesn't exist on disk yet
            # because the call is still in progress). File and webhook
            # channels fire immediately so the caller gets confirmation
            # and the message is durable on disk before we say "saved".
            await self._dispatcher.dispatch_message(
                msg, DispatchContext(
                    business_name=self.config.business.name,
                    call_id=self.lifecycle.metadata.call_id,
                ),
                skip_email_channel=True,
            )
        except Exception as e:
            logger.error("take_message: synchronous dispatch failed: %s", e)
            return "I'm having trouble saving messages right now. Would you like me to transfer you to someone instead?"

        self.lifecycle.enqueue_message_email(msg)
        self.lifecycle.record_captured_message(msg)
        self.lifecycle.record_message_taken()
        return f"Message saved from {caller_name}. Let them know their message has been recorded and someone will get back to them."

    @function_tool()
    async def record_intake_answer(
        self,
        ctx: RunContext,
        case_type: str,
        question_key: str,
        spoken_text: str,
        language: str = "en",
        english_summary: str = "",
    ) -> str:
        """Record one answer in an in-progress phone intake.

        Call this after EVERY answered intake question — once per question.
        The partial intake is persisted to disk after each call, so if the
        caller hangs up mid-intake the receiving team still gets whatever
        was captured.

        Args:
            case_type: case-type key from the configured intakes block
                (e.g. "workers_comp", "ssd", "pension"). Must match one of
                the configured case types.
            question_key: the question.key from that case type's question
                list. Must be one of the keys you were shown.
            spoken_text: the caller's answer, verbatim, in whatever
                language they used. Do NOT translate this field.
            language: ISO 639-1 code of the spoken_text ("en", "es", ...).
                Defaults to "en".
            english_summary: a concise English rendering of the answer
                so an English-only reader can scan the submission. For
                English calls, this may be identical to spoken_text.
        """
        from receptionist.intakes.storage import persist_partial
        from receptionist.intakes.models import IntakeSubmission

        if self.config.intakes is None or not self.config.intakes.enabled:
            return (
                "Intake is not enabled for this business. Use take_message "
                "to record the caller's information instead."
            )
        case_types_by_key = {ct.key: ct for ct in self.config.intakes.case_types}
        case_type_cfg = case_types_by_key.get(case_type)
        if case_type_cfg is None:
            available = ", ".join(sorted(case_types_by_key.keys()))
            return (
                f"Unknown case type {case_type!r}. Configured case types: "
                f"{available}. Ask the caller which type applies and try again."
            )
        questions_by_key = {q.key: q for q in case_type_cfg.questions}
        question_cfg = questions_by_key.get(question_key)
        if question_cfg is None:
            available = ", ".join(sorted(questions_by_key.keys()))
            return (
                f"Unknown question key {question_key!r} for case type "
                f"{case_type!r}. Valid keys: {available}."
            )

        call_id = self.lifecycle.metadata.call_id
        spoken_text = _cap("intake_spoken_text", spoken_text, call_id=call_id) or ""
        english_summary = _cap("intake_english_summary", english_summary, call_id=call_id) or ""

        # If the case type changed mid-call (unusual but possible — caller
        # corrected themselves about which kind of case they have), drop
        # prior answers so we don't mix-and-match answer sets across case
        # types.
        if self._intake_case_type is not None and self._intake_case_type != case_type:
            logger.info(
                "Intake case_type changed mid-call: %s -> %s; clearing prior answers",
                self._intake_case_type, case_type,
                extra={"call_id": call_id, "component": "agent.intake"},
            )
            self._intake_answers.clear()
        self._intake_case_type = case_type
        self._intake_language = language or "en"
        if self._intake_started_at is None:
            from datetime import datetime, timezone as _tz
            self._intake_started_at = datetime.now(_tz.utc).isoformat()

        self._intake_answers[question_key] = self._IntakeAnswer(
            question_key=question_key,
            prompt=question_cfg.prompt_en,
            spoken_text=spoken_text,
            language=self._intake_language,
            english_summary=english_summary or spoken_text,
        )

        submission = IntakeSubmission(
            case_type=case_type,
            business_name=self.config.business.name,
            call_id=call_id,
            caller_name="",  # not yet known; finalize_intake captures it
            callback_number="",
            answers=list(self._intake_answers.values()),
            language=self._intake_language,
            english_overview="",
            status="partial",
            started_at=self._intake_started_at,
        )

        # Persist a partial after every answer so a mid-call disconnect
        # still leaves the receiving team with what was captured.
        try:
            await persist_partial(submission, self.config.intakes.submission.file_path)
        except Exception as e:
            logger.exception(
                "Intake partial persist failed for question %s: %s",
                question_key, e,
                extra={"call_id": call_id, "component": "agent.intake"},
            )
            # Do NOT fail the tool — the in-memory answer is still tracked
            # and finalize_intake will retry the write.

        self.lifecycle.enqueue_intake_submission(
            submission, case_type_display=case_type_cfg.display_name,
        )
        return f"Answer recorded for {question_key}. Proceed to the next question."

    @function_tool()
    async def await_keypad_entry(self, ctx: RunContext, question_key: str) -> str:
        """Collect a digit-only intake answer from the caller's phone keypad.

        Use this INSTEAD of asking the caller to say the number for any intake
        question marked for keypad entry (phone numbers, SSNs). Tell the caller
        to type the number on their phone keypad and press the pound key. This
        tool returns the exact digits they typed. Read those digits back to the
        caller to confirm, then call record_intake_answer with the confirmed
        digits. If this tool reports a timeout, ask the caller to say the
        number and read it back digit by digit before recording.

        Args:
            question_key: the question.key of the keypad question being asked.
        """
        if self.config.intakes is None or not self.config.intakes.enabled:
            return (
                "Intake is not enabled. Use take_message to record the caller's "
                "information instead."
            )
        question = None
        for ct in self.config.intakes.case_types:
            for q in ct.questions:
                if q.key == question_key:
                    question = q
                    break
            if question is not None:
                break
        if question is None or question.input != "dtmf":
            return (
                f"Question {question_key!r} is not a keypad-entry question. Ask "
                "the caller to say the answer instead."
            )
        if self._dtmf_state is None:
            logger.warning(
                "await_keypad_entry: no DTMF handler wired; voice fallback",
                extra={
                    "call_id": self.lifecycle.metadata.call_id,
                    "component": "agent.dtmf_capture",
                },
            )
            return _KEYPAD_VOICE_FALLBACK

        loop = asyncio.get_running_loop()
        future: asyncio.Future = loop.create_future()
        # If a prior keypad entry is still pending (model re-called this tool),
        # cancel its future so the earlier call unblocks immediately instead of
        # hanging until its 30s timeout.
        prev = self._dtmf_state.capture
        if prev is not None and not prev.future.done():
            prev.future.cancel()
        self._dtmf_state.capture = _ActiveCapture(
            buffer=DigitCaptureBuffer(expected_length=question.dtmf_length),
            future=future,
            question_key=question_key,
        )
        try:
            digits = await asyncio.wait_for(
                future, timeout=_KEYPAD_ENTRY_TIMEOUT_SECONDS,
            )
        except asyncio.CancelledError:
            # A newer await_keypad_entry call superseded this one and cancelled
            # our future. Do NOT touch _dtmf_state.capture — it now holds the
            # newer call's live capture. Just return a benign fallback.
            return _KEYPAD_VOICE_FALLBACK
        except asyncio.TimeoutError:
            self._dtmf_state.capture = None
            self.lifecycle.record_dtmf_event(
                digit="", action="intake_capture", target=question_key,
                status="intake_capture_timeout",
            )
            logger.info(
                "await_keypad_entry: timed out for %s; voice fallback",
                question_key,
                extra={
                    "call_id": self.lifecycle.metadata.call_id,
                    "component": "agent.dtmf_capture",
                },
            )
            return _KEYPAD_VOICE_FALLBACK
        except Exception:
            self._dtmf_state.capture = None
            logger.exception(
                "await_keypad_entry: unexpected error; voice fallback",
                extra={
                    "call_id": self.lifecycle.metadata.call_id,
                    "component": "agent.dtmf_capture",
                },
            )
            return _KEYPAD_VOICE_FALLBACK

        return (
            f"The caller typed: {digits}. Read these digits back one at a time "
            "to confirm, then call record_intake_answer with this exact value."
        )

    @function_tool()
    async def finalize_intake(
        self,
        ctx: RunContext,
        caller_name: str,
        callback_number: str,
        english_overview: str = "",
    ) -> str:
        """Submit the completed intake.

        Call this exactly once, after all required questions for the
        chosen case type have been answered and you've confirmed the
        critical fields (legal name, callback, email if collected) with
        the caller. Do NOT call this before record_intake_answer has run
        for every required question.

        Args:
            caller_name: full legal name as the caller stated it, after
                you read it back letter-by-letter and they confirmed.
            callback_number: callback phone number, after you read it
                back digit-by-digit and they confirmed.
            english_overview: 1-3 sentence English summary of the case
                in the caller's own framing. Helps the intake team
                triage without reading every answer.
        """
        from receptionist.intakes.storage import persist_final
        from receptionist.intakes.models import IntakeSubmission
        from datetime import datetime, timezone as _tz

        if self.config.intakes is None or not self.config.intakes.enabled:
            return "Intake is not enabled for this business."
        if self._intake_case_type is None or not self._intake_answers:
            return (
                "No intake answers have been recorded yet. Call "
                "record_intake_answer for each question first."
            )

        call_id = self.lifecycle.metadata.call_id
        caller_name = _cap("caller_name", caller_name, call_id=call_id) or ""
        callback_number = _cap("callback_number", callback_number, call_id=call_id) or ""
        english_overview = _cap(
            "intake_english_overview", english_overview, call_id=call_id,
        ) or ""

        # Look up the case-type display name for the email subject. The
        # tool already validated case_type via record_intake_answer's
        # guard, but be defensive in case finalize_intake is called with
        # a stale case_type after a clear.
        case_types_by_key = {ct.key: ct for ct in self.config.intakes.case_types}
        case_type_cfg = case_types_by_key.get(self._intake_case_type)
        display = case_type_cfg.display_name if case_type_cfg else self._intake_case_type

        submission = IntakeSubmission(
            case_type=self._intake_case_type,
            business_name=self.config.business.name,
            call_id=call_id,
            caller_name=caller_name,
            callback_number=callback_number,
            answers=list(self._intake_answers.values()),
            language=self._intake_language,
            english_overview=english_overview,
            status="final",
            started_at=self._intake_started_at or datetime.now(_tz.utc).isoformat(),
            completed_at=datetime.now(_tz.utc).isoformat(),
        )

        try:
            await persist_final(submission, self.config.intakes.submission.file_path)
        except Exception as e:
            logger.exception(
                "Intake final persist failed: %s", e,
                extra={"call_id": call_id, "component": "agent.intake"},
            )
            return (
                "I had trouble saving the intake. Let me take a short "
                "message with your name and number instead."
            )

        self.lifecycle.enqueue_intake_submission(
            submission, case_type_display=display,
        )
        self.lifecycle.record_intake_submitted()
        packet_instruction = ""
        packets_cfg = self.config.info_packets
        if packets_cfg is not None and packets_cfg.enabled:
            packet_instruction = (
                " Ask whether the caller wants an approved information packet "
                "emailed. Only call send_info_packet after the caller gives "
                "permission and confirms their email address."
            )
        return (
            f"Intake submitted for {display}. Let the caller know "
            f"someone from the office will follow up during business hours."
            f"{packet_instruction}"
        )

    @function_tool()
    async def send_info_packet(
        self,
        ctx: RunContext,
        packet_key: str,
        channel: str = "email",
        destination: str = "",
        consent_confirmed: bool = False,
        destination_confirmed: bool = False,
    ) -> str:
        """Send a configured information packet after caller consent. The
        first call with a destination returns a read-back instruction; the
        send happens only when called again with destination_confirmed=true
        and the same address."""
        packets_cfg = self.config.info_packets
        if packets_cfg is None or not packets_cfg.enabled:
            return (
                "Information packet sending is not enabled. Tell the caller "
                "the office will follow up."
            )
        if channel.lower() != "email":
            return "I can only send information packets by email right now."
        destination = (destination or "").strip()
        if not is_valid_email_destination(destination):
            return (
                "That email address does not look valid. Ask the caller to "
                "spell it again."
            )
        packet = packets_cfg.by_key().get(packet_key)
        if packet is None:
            available = ", ".join(sorted(packets_cfg.by_key().keys()))
            return (
                f"Unknown information packet {packet_key!r}. Available "
                f"packets: {available}."
            )
        if self.config.email is None:
            return (
                "Information packet email is not configured. Tell the caller "
                "the office will follow up."
            )
        normalized = destination.lower()
        # A confirming second call (destination_confirmed=true on the same
        # address we previously handed back) completes the send. Consent was
        # already established on the first call — which had to pass
        # consent_confirmed=true to reach the read-back — so we do NOT re-demand
        # consent_confirmed here. The model, following the read-back
        # instruction, only re-asserts destination_confirmed=true.
        is_confirming = (
            destination_confirmed
            and self._pending_packet_destination == normalized
        )
        if not is_confirming:
            # First call (or a corrected/new address): require consent, then
            # arm the pending destination and hand it back for read-back.
            if not consent_confirmed:
                return (
                    "Ask the caller for permission and confirm the email address "
                    "before sending."
                )
            self._pending_packet_destination = normalized
            return (
                "Do not send yet. Read this email address back to the caller "
                f"letter by letter exactly as written: {destination}. After the "
                "caller explicitly confirms it is correct, call send_info_packet "
                "again with the same destination and destination_confirmed=true. "
                "If the caller corrects the address, call again with the "
                "corrected address."
            )
        try:
            await send_info_packet_email(
                packet=packet,
                email_config=self.config.email,
                destination=destination,
                business_name=self.config.business.name,
                call_id=self.lifecycle.metadata.call_id,
            )
        except Exception:
            logger.exception(
                "send_info_packet failed",
                extra={
                    "call_id": self.lifecycle.metadata.call_id,
                    "component": "agent.info_packets",
                    "packet_key": packet.key,
                },
            )
            self.lifecycle.record_info_packet_failed(
                packet_key=packet.key,
                packet_display_name=packet.display_name,
                channel="email",
                destination=destination,
                error="transport_failed",
            )
            return (
                "I had trouble sending that packet. Let the caller know the "
                "office will follow up."
            )
        self.lifecycle.record_info_packet_sent(
            packet_key=packet.key,
            packet_display_name=packet.display_name,
            channel="email",
            destination=destination,
        )
        # Clear the gate so a stale confirmation can't trigger an accidental
        # duplicate send. (On transport failure above it stays set, so a
        # retry with the same confirmed address still works.)
        self._pending_packet_destination = None
        return f"Information packet sent to {destination}."

    @function_tool()
    async def end_call(
        self, ctx: RunContext, reason: str = "caller_goodbye",
    ) -> str:
        """End the call after a brief goodbye.

        Use this when the caller has clearly finished the conversation —
        for example "goodbye", "thanks, bye", "that's all I needed", or when
        you've told the caller you have no further help to offer and they
        have nothing else to ask. Do NOT use this just because the caller
        is quiet for a moment, mid-question, or asking for something you
        haven't tried yet.

        Args:
            reason: short label for *why* the agent ended the call. Stored
                on the call summary so staff can audit agent-initiated
                hangups. Allowed values: `caller_goodbye` (default),
                `silence_timeout`, `unproductive_turns_exhausted`,
                `max_duration_reached`. Any other value is replaced with
                `caller_goodbye`.
        """
        safe_reason = reason if reason in _AGENT_END_REASONS else "caller_goodbye"
        # Record the outcome synchronously so even if the background hangup
        # task races a caller-initiated close, the call summary already
        # shows agent-ended with this reason.
        self.lifecycle.record_agent_ended(safe_reason)

        # Schedule the actual hangup in the background so the tool can return
        # immediately (the LLM gets the tool response right away; the caller
        # hears the goodbye and disconnects via the background task).
        job_ctx = get_job_context()
        session = ctx.session
        lifecycle = self.lifecycle

        async def _run_end() -> None:
            await _speak_goodbye_and_terminate(
                session, lifecycle, job_ctx, reason=safe_reason,
            )

        _create_background_task(_run_end())
        return f"Agent ending the call (reason={safe_reason})."

    # ------------------------------------------------------------------
    # Issue #11 unproductive-turn counter
    # ------------------------------------------------------------------

    def _on_user_input_transcribed(self, ev) -> None:
        """Reset per-turn flags whenever a final user transcript arrives.

        Listener is attached in `handle_call` after the session is built.
        The agent's `conversation_item_added` event for the matching
        assistant reply later in the same turn checks this flag.
        """
        if not getattr(ev, "is_final", False):
            return
        # Safety net: flag emergency symptoms even if the LLM misses them.
        try:
            from receptionist.integrations.emergency import detect_emergency
            hits = detect_emergency(getattr(ev, "transcript", ""))
            if hits:
                self.lifecycle.mark_urgent(hits)
                self._alert_staff(hits)
                logger.warning(
                    "emergency keywords detected: %s", ", ".join(hits),
                    extra={"call_id": self.lifecycle.metadata.call_id, "component": "agent.emergency"},
                )
        except Exception:
            logger.exception("emergency detection failed")
        self._current_turn_has_user_input = True
        self._current_turn_used_tool = False
        self._current_turn_assistant_replied = False

    def _on_function_tools_executed(self, _ev) -> None:
        """A function tool ran => this turn is productive => reset counter."""
        self._current_turn_used_tool = True
        if self._consecutive_unproductive_turns:
            logger.debug(
                "unproductive_turns: tool fired, resetting counter from %d to 0",
                self._consecutive_unproductive_turns,
                extra={"call_id": self.lifecycle.metadata.call_id, "component": "agent.unproductive"},
            )
        self._consecutive_unproductive_turns = 0

    def _on_conversation_item_added(self, ev) -> None:
        """Score the agent's reply for unproductiveness and trigger end_call
        when the threshold is reached.
        """
        user_item = getattr(ev, "item", None)
        if user_item is not None and getattr(user_item, "role", None) == "user":
            # Typed chat messages arrive here (spoken ones too); run the
            # emergency safety net on them as well.
            try:
                from receptionist.integrations.emergency import detect_emergency
                hits = detect_emergency(_extract_message_text(user_item))
                if hits:
                    self.lifecycle.mark_urgent(hits)
                    self._alert_staff(hits)
            except Exception:
                logger.exception("emergency detection (chat) failed")
            return
        if self._current_turn_assistant_replied:
            # The assistant added a follow-up message in the same turn (rare).
            # Only score the first reply per user turn to avoid double-counting.
            return
        item = getattr(ev, "item", None)
        if item is None or getattr(item, "role", None) != "assistant":
            return
        if not self._current_turn_has_user_input:
            # Ignore greetings, consent preambles, and other proactive agent
            # speech before the caller has produced a final transcript.
            return
        self._current_turn_assistant_replied = True

        idle_cfg = self.config.voice.idle
        if not idle_cfg.unproductive_hangup_enabled:
            return
        if self._current_turn_used_tool:
            self._consecutive_unproductive_turns = 0
            return

        text = _extract_message_text(item)
        if not text:
            return

        text_lower = text.lower()
        is_unproductive = any(
            phrase in text_lower for phrase in idle_cfg.unproductive_phrases
        )
        if not is_unproductive:
            self._consecutive_unproductive_turns = 0
            return

        self._consecutive_unproductive_turns += 1
        log_extra = {
            "call_id": self.lifecycle.metadata.call_id,
            "component": "agent.unproductive",
            "count": self._consecutive_unproductive_turns,
            "threshold": idle_cfg.unproductive_turn_threshold,
        }
        logger.info(
            "unproductive_turns: count=%d threshold=%d",
            self._consecutive_unproductive_turns,
            idle_cfg.unproductive_turn_threshold,
            extra=log_extra,
        )
        if self._consecutive_unproductive_turns < idle_cfg.unproductive_turn_threshold:
            return

        # Threshold reached — schedule the agent-initiated end. Guard with a
        # one-shot flag so we don't double-fire if more replies come in
        # between scheduling and termination.
        if self._unproductive_end_scheduled:
            return
        self._unproductive_end_scheduled = True
        logger.warning(
            "unproductive_turns: threshold reached, ending call",
            extra=log_extra,
        )

        try:
            job_ctx = get_job_context()
        except RuntimeError:
            logger.exception(
                "unproductive_turns: no job context; cannot end call",
                extra=log_extra,
            )
            return
        session = self.session
        lifecycle = self.lifecycle
        lifecycle.record_agent_ended("unproductive_turns_exhausted")

        async def _run() -> None:
            await _speak_goodbye_and_terminate(
                session, lifecycle, job_ctx,
                reason="unproductive_turns_exhausted",
            )

        _create_background_task(_run())

    @function_tool()
    async def get_business_hours(self, ctx: RunContext) -> str:
        """Check the current business hours and whether the business is open right now."""
        tz = ZoneInfo(self.config.business.timezone)
        now = datetime.now(tz)
        day_name = now.strftime("%A").lower()
        day_hours = getattr(self.config.hours, day_name)

        if day_hours is None:
            return f"The business is closed today ({now.strftime('%A')}). {self.config.after_hours_message}"

        current_time = now.strftime("%H:%M")
        if day_hours.open <= current_time <= day_hours.close:
            return f"The business is currently open. Today's hours are {day_hours.open} to {day_hours.close}."
        return f"The business is currently closed. Today's hours are {day_hours.open} to {day_hours.close}. {self.config.after_hours_message}"

    @function_tool()
    async def check_availability(
        self,
        ctx: RunContext,
        preferred_date: str,
        preferred_time: str,
        doctor: str | None = None,
    ) -> str:
        """Check the calendar for available appointment slots near a caller-requested time.

        Args:
            preferred_date: the date as YYYY-MM-DD. Convert whatever the caller
                said in any language (e.g. "kal", "কাল", "कल" = tomorrow) into a date.
            preferred_time: the time as HH:MM, 24-hour (e.g. "18:00"). Use 10:00
                for morning, 16:00 for afternoon, 18:00 for evening if no exact time.
            doctor: the doctor's name when the clinic has several doctors.
        """
        # CalendarAuthError lives in booking/auth.py which transitively imports
        # google-auth — keep it lazy so calendar-disabled businesses don't pay
        # the import cost.
        from receptionist.booking.auth import CalendarAuthError

        if self.config.calendar is None or not self.config.calendar.enabled:
            return (
                "I'm sorry, we don't have online booking set up. I can take a "
                "message about your preferred time and have someone call you back."
            )

        tz = ZoneInfo(self.config.business.timezone)
        now = datetime.now(tz)

        # Resolve relative-date words ("today", "tomorrow", "next Monday") that
        # dateutil.parser doesn't understand on its own. Bare weekday names ("Monday")
        # and absolute dates ("April 28") fall through to the parser unchanged.
        preferred_date, preferred_time = _normalize_when(preferred_date, preferred_time, now)
        preferred_date = _resolve_relative_date(preferred_date, now)

        # Parse caller's natural-language date + time into a tz-aware datetime
        try:
            combined = f"{preferred_date} {preferred_time}"
            # minute=0 so "11am" means 11:00, not 11:<current minute>.
            parsed = dateparser.parse(combined, default=now.replace(
                minute=0, second=0, microsecond=0,
            ))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=tz)
        except (ValueError, TypeError) as e:
            logger.info("check_availability: could not parse %r %r: %s", preferred_date, preferred_time, e)
            return (
                "The date/time could not be parsed. Call check_availability again with "
                "preferred_date as YYYY-MM-DD and preferred_time as HH:MM (24-hour), "
                f"converted from what the caller said (today is {now.strftime('%A %Y-%m-%d')}). "
                "Only ask the caller again if you truly don't know the day."
            )

        earliest = now + timedelta(hours=self.config.calendar.earliest_booking_hours_ahead)
        latest = now + timedelta(days=self.config.calendar.booking_window_days)

        # Hard constraint checks (before hitting Google)
        if parsed < earliest:
            return (
                f"I can only book appointments at least "
                f"{self.config.calendar.earliest_booking_hours_ahead} hours from now. "
                f"The earliest I can offer is {_format_friendly_date(earliest)}."
            )
        if parsed > latest:
            return (
                f"I can only book up to {self.config.calendar.booking_window_days} "
                f"days out. Would you like a time sooner than "
                f"{latest.strftime('%A, %B %d')}?"
            )

        doc, problem = self._resolve_doctor(doctor)
        if problem:
            return problem
        try:
            client = await self._get_calendar_client_async()
            if doc is None:
                busy = await client.free_busy(earliest, latest)
            else:
                busy = await self._doctor_busy(client, doc, earliest, latest)
        except CalendarAuthError:
            logger.exception("check_availability: auth error")
            return (
                "I'm having trouble accessing our calendar right now. Can I take "
                "a message about your preferred time and have someone call you back?"
            )
        except Exception:
            logger.exception("check_availability: client error")
            return (
                "I can't check availability at the moment. Can I take a message "
                "about the time you wanted?"
            )

        slots = find_slots(
            business_hours=self._hours_for(doc),
            business_timezone=self.config.business.timezone,
            calendar_config=self._calendar_for(doc),
            preferred_dt=parsed,
            existing_busy=busy,
            earliest=earliest,
            latest=latest,
            now=now,
        )

        if not slots:
            return (
                f"I don't see any openings{(' with ' + doc.name) if doc is not None else ''} near {_format_friendly_date(parsed)}"
                f"{' (the doctor may be on leave or not working that day)' if doc is not None else ''}. "
                f"Would you like me to take a message so someone can offer alternatives?"
            )

        # Cache the ISO strings so book_appointment can validate them.
        # Bounded to last 3 batches (deque maxlen=3) — older batches age out.
        self._record_offered_slots(s.start_iso for s in slots)
        if doc is not None:
            for s_ in slots:
                self._slot_doctor[s_.start_iso] = doc.name

        # Format a caller-friendly response. The LLM takes this and speaks it.
        formatted = []
        for i, slot in enumerate(slots, start=1):
            dt = datetime.fromisoformat(slot.start_iso)
            human = _format_friendly_date(dt)
            # Also include the ISO string so the LLM can pass it back to book_appointment
            formatted.append(f"{i}. {human}  [iso={slot.start_iso}]")

        with_doc = f" with {doc.name}" if doc is not None else ""
        requested_day = parsed.astimezone(tz).date()
        other_day_note = ""
        if all(datetime.fromisoformat(s_.start_iso).astimezone(tz).date() != requested_day for s_ in slots):
            other_day_note = (
                f"NOTE: nothing is free{with_doc} on {requested_day.strftime('%A, %B %d')}. "
                "These slots are on a DIFFERENT day — say the actual weekday and date to "
                "the caller, never 'tomorrow' or 'today' unless it really is. "
            )
        return (
            other_day_note +
            f"I found these available times{with_doc} near your preferred slot. "
            f"Confirm the one the caller chose, then call book_appointment with "
            f"the exact iso= string shown.\n" + "\n".join(formatted)
        )

    @function_tool()
    async def book_appointment(
        self,
        ctx: RunContext,
        caller_name: str,
        callback_number: str,
        proposed_start_iso: str,
        notes: str | None = None,
        caller_email: str | None = None,
        doctor: str | None = None,
    ) -> str:
        """Book an appointment at a previously-offered time.

        Args:
            caller_name: the caller's full name
            callback_number: the caller's phone number
            proposed_start_iso: the exact ISO 8601 start datetime offered by
                a prior check_availability call. Copy from that response.
            notes: optional free-form note to include in the event description.
            doctor: the doctor's name (defaults to the doctor the slot was offered for).
            caller_email: optional email address to send a calendar invite to.
                When provided, the caller is added as an OPTIONAL attendee and
                Google sends them the standard invite email with .ics file and
                accept/decline. Leave None if the caller didn't volunteer an
                email — never make one up.
        """
        # booking.booking imports booking.client which pulls google-api-
        # python-client at module load (~50MB). Keep it lazy so businesses
        # with calendar disabled don't pay that import cost. Aliased to
        # _book to avoid shadowing this method's own name.
        from receptionist.booking.booking import (
            SlotNoLongerAvailableError, book_appointment as _book,
        )

        if self.config.calendar is None or not self.config.calendar.enabled:
            return "Calendar booking is not enabled for this business."

        # Enforce "must check before book" — slot must have been offered
        if not self._slot_was_offered(proposed_start_iso):
            return (
                "I need to verify that time is still available. Let me check "
                "first — please call check_availability before booking."
            )

        # Cap caller free-text fields to avoid bloating the calendar event
        # description and email body. Long input is truncated, not rejected,
        # so the booking still flows; the truncation is logged.
        call_id = self.lifecycle.metadata.call_id
        caller_name = _cap("caller_name", caller_name, call_id=call_id) or ""
        callback_number = _cap("callback_number", callback_number, call_id=call_id) or ""
        notes = _cap("notes", notes, call_id=call_id)
        caller_email = _cap("caller_email", caller_email, call_id=call_id)

        # Light email-shape validation. Google rejects malformed emails too,
        # but catching obvious mishearings here gives a friendlier error.
        if caller_email is not None:
            caller_email = caller_email.strip()
            if not _EMAIL_RE.match(caller_email):
                logger.info("book_appointment: invalid caller_email redacted")
                return (
                    "That email address didn't sound quite right. Could you "
                    "spell it out for me, or should I proceed without sending "
                    "an email invite?"
                )

        # Reconstruct the matching SlotProposal. We trust start_iso and compute
        # the end from appointment_duration_minutes (slots have uniform duration).
        doc, problem = self._resolve_doctor(doctor or self._slot_doctor.get(proposed_start_iso))
        if problem:
            return problem
        start = datetime.fromisoformat(proposed_start_iso)
        duration = timedelta(minutes=self._calendar_for(doc).appointment_duration_minutes)
        slot = SlotProposal(
            start_iso=proposed_start_iso,
            end_iso=(start + duration).isoformat(),
        )

        token = None
        try:
            client = await self._get_calendar_client_async()
            extra = {}
            if doc is not None:
                token = await self._token_for(client, doc, start)
                extra = {
                    "doctor": doc.name, "token": token,
                    "is_busy": lambda s_, e_: self._doctor_is_busy(client, doc, s_, e_),
                }
            result = await _book(
                slot=slot,
                caller_name=caller_name,
                callback_number=callback_number,
                call_id=self.lifecycle.metadata.call_id,
                time_zone=self.config.business.timezone,
                client=client,
                notes=notes,
                caller_email=caller_email,
                **extra,
            )
        except SlotNoLongerAvailableError:
            # Slot just got taken. Find fresh alternatives.
            tz = ZoneInfo(self.config.business.timezone)
            now = datetime.now(tz)
            earliest = now + timedelta(hours=self.config.calendar.earliest_booking_hours_ahead)
            latest = now + timedelta(days=self.config.calendar.booking_window_days)
            try:
                if doc is None:
                    busy = await client.free_busy(earliest, latest)
                else:
                    busy = await self._doctor_busy(client, doc, earliest, latest)
                alternates = find_slots(
                    business_hours=self._hours_for(doc),
                    business_timezone=self.config.business.timezone,
                    calendar_config=self._calendar_for(doc),
                    preferred_dt=start,
                    existing_busy=busy,
                    earliest=earliest,
                    latest=latest,
                    now=now,
                )
            except Exception:
                logger.exception("book_appointment: failed to find alternates after race")
                alternates = []

            # Reset cache to ONLY the new set. We deliberately discard the
            # previously-offered slots (some of which may still be free), to
            # force the LLM through a fresh check_availability if it wants
            # one of those — the previously-cached slots are stale (>=1
            # extra round-trip ago) and the safer path is "always re-check
            # when in doubt." Trade-off: one extra tool call vs. risk of
            # offering a now-also-stale slot.
            self._reset_offered_slots(s.start_iso for s in alternates)
            if doc is not None:
                for s_ in alternates:
                    self._slot_doctor[s_.start_iso] = doc.name
            if alternates:
                formatted = "\n".join(
                    f"- {_format_friendly_date(datetime.fromisoformat(s.start_iso))}  [iso={s.start_iso}]"
                    for s in alternates
                )
                return (
                    f"Unfortunately that slot just got taken. Here are the "
                    f"nearest alternatives:\n{formatted}"
                )
            return (
                "Unfortunately that slot just got taken, and I can't find "
                "nearby alternatives right now. Would you like me to take a "
                "message so someone can call you back with options?"
            )
        except Exception:
            logger.exception("book_appointment: unexpected error")
            return (
                "I had trouble booking that time. Can I take a message with "
                "the time you wanted, and someone will confirm with you?"
            )

        # Success — record on lifecycle, return confirmation
        self.lifecycle.record_appointment_booked({
            "event_id": result.event_id,
            "start_iso": result.start_iso,
            "end_iso": result.end_iso,
            "html_link": result.html_link,
            "doctor": doc.name if doc is not None else None,
            "token": token,
        })

        confirmed = datetime.fromisoformat(result.start_iso)
        invite_msg = (
            f" I've also emailed a calendar invite to {caller_email}."
            if caller_email else ""
        )
        token_msg = (
            f" Tell the caller their OPD token number is {token} for {doc.name}."
            if token else ""
        )
        with_doc = f" with {doc.name}" if doc is not None else ""
        return (
            f"You're all set{with_doc} for {_format_friendly_date(confirmed)}.{invite_msg}{token_msg} "
            f"Someone will contact you at {callback_number} if we need to confirm."
        )


    @function_tool()
    async def report_emergency(
        self,
        ctx: RunContext,
        symptoms: str,
        callback_number: str | None = None,
        caller_name: str | None = None,
    ) -> str:
        """Flag a possible medical emergency so clinic staff are alerted immediately.

        Call this as soon as the caller describes emergency symptoms (chest pain,
        trouble breathing, unconsciousness, heavy bleeding, stroke signs, seizure,
        poisoning, severe injury, suicidal thoughts), BEFORE continuing anything else.

        Args:
            symptoms: short description of what the caller reported.
            callback_number: caller's phone number if they gave one.
            caller_name: caller's name if they gave one.
        """
        call_id = self.lifecycle.metadata.call_id
        report = {
            "symptoms": _cap("notes", symptoms, call_id=call_id) or "",
            "callback_number": _cap("callback_number", callback_number, call_id=call_id),
            "caller_name": _cap("caller_name", caller_name, call_id=call_id),
            "reported_at": datetime.now(ZoneInfo(self.config.business.timezone)).isoformat(),
        }
        self.lifecycle.mark_urgent((), report=report)
        self._alert_staff((), report=report)
        logger.warning(
            "report_emergency: %s", report["symptoms"],
            extra={"call_id": call_id, "component": "agent.emergency"},
        )
        h = self.config.hospital
        numbers = ""
        if h is not None and (h.emergency_phone or h.ambulance_phone):
            bits = []
            if h.emergency_phone:
                bits.append(f"our 24x7 emergency desk {h.emergency_phone}")
            if h.ambulance_phone:
                bits.append(f"ambulance {h.ambulance_phone}")
            numbers = " Also give them " + " and ".join(bits) + ", digit by digit."
        return (
            "Staff have been alerted. Now tell the caller clearly and calmly: this may "
            "be an emergency, they should call 112 right now or go to the nearest "
            "hospital emergency department." + numbers + " Do not give medical advice or a diagnosis. "
            "If you don't have a callback number yet, ask for one. Do not book an "
            "appointment instead of emergency care."
        )

    def _alert_staff(self, keywords=(), report: dict | None = None) -> None:
        """Send a live emergency alert to the website (once per new keyword / report)."""
        try:
            from receptionist.integrations.dashboard import dashboard_url, post_emergency_alert
            if not dashboard_url():
                return
            sent = self.__dict__.setdefault("_alerted_keywords", set())
            new = set(keywords or ()) - sent
            if not new and not report:
                return
            sent |= new
            md = self.lifecycle.metadata
            task = asyncio.create_task(post_emergency_alert(
                md.call_id, keywords=self.lifecycle.urgent_keywords, report=report,
                caller_phone=md.caller_phone))
            self.__dict__.setdefault("_bg_tasks", set()).add(task)
            task.add_done_callback(lambda t: self.__dict__["_bg_tasks"].discard(t))
        except Exception:
            logger.exception("could not send emergency alert")

    # ------------------------------------------------------------------
    # Hospital: lab report status + OPD queue (answered from the website)
    # ------------------------------------------------------------------

    @function_tool()
    async def check_report_status(
        self, ctx: RunContext, callback_number: str, report_id: str | None = None,
    ) -> str:
        """Check whether a caller's lab test or scan report is ready.

        Args:
            callback_number: the phone number the patient registered with (read it back first).
            report_id: the report / bill number if the caller has one, otherwise leave empty.
        """
        from receptionist.integrations.dashboard import fetch_report_status
        data = await fetch_report_status(callback_number, report_id)
        if data is None:
            return ("The report system can't be reached right now. Offer to take a message so "
                    "the lab can call them back.")
        reports = data.get("reports") or []
        if not reports:
            return ("No reports found for that number. Ask them to check the number used at "
                    "registration, or offer to take a message for the lab.")
        lines = []
        for r in reports[:4]:
            status = {"ready": "READY to collect", "collected": "already collected",
                      "processing": "still being processed"}.get(r.get("status"), r.get("status"))
            extra = f", expected {r['expected']}" if r.get("expected") and r.get("status") == "processing" else ""
            lines.append(f"- {r.get('test') or 'Report'} ({r.get('date') or ''}): {status}{extra}")
        collect = data.get("collect") or ""
        return ("Reports for this number:\n" + "\n".join(lines)
                + (f"\nCollection: {collect}" if collect else "")
                + "\nTell the caller ONLY the status. Never read out or guess results.")

    @function_tool()
    async def check_opd_queue(self, ctx: RunContext, doctor: str | None = None) -> str:
        """Tell the caller which OPD token number is being seen right now.

        Args:
            doctor: the doctor's name, or leave empty for all doctors.
        """
        from receptionist.booking.booking import normalize_doctor
        from receptionist.integrations.dashboard import fetch_queue
        data = await fetch_queue()
        if data is None:
            return "The queue display can't be reached right now. Say you can't check it at the moment."
        items = data.get("items") or []
        if doctor:
            key = normalize_doctor(doctor)
            items = [i for i in items if key and (key in normalize_doctor(i.get("doctor", ""))
                                                    or normalize_doctor(i.get("doctor", "")) in key)] or items
        if not items:
            return "No OPD is running today."
        lines = [f"- {i['doctor']}: now serving token {i.get('nowServing') or 'not started'}"
                 + (f", {i.get('waiting')} waiting" if i.get("waiting") is not None else "")
                 for i in items]
        return "OPD queue right now:\n" + "\n".join(lines)

    # ------------------------------------------------------------------
    # Find / cancel / reschedule existing appointments
    # ------------------------------------------------------------------

    @function_tool()
    async def find_my_appointment(
        self,
        ctx: RunContext,
        callback_number: str,
        caller_name: str | None = None,
    ) -> str:
        """Look up the caller's upcoming appointments so they can cancel or reschedule.

        Args:
            callback_number: the phone number the caller booked with. Read it
                back digit-by-digit and get a "yes" before calling this.
            caller_name: optional name the booking was made under.
        """
        from receptionist.booking.auth import CalendarAuthError
        from receptionist.booking.booking import find_appointments

        if self.config.calendar is None or not self.config.calendar.enabled:
            return "Calendar booking is not enabled for this business."

        call_id = self.lifecycle.metadata.call_id
        callback_number = _cap("callback_number", callback_number, call_id=call_id) or ""
        caller_name = _cap("caller_name", caller_name, call_id=call_id)

        tz = ZoneInfo(self.config.business.timezone)
        now = datetime.now(tz)
        until = now + timedelta(days=max(self.config.calendar.booking_window_days, 60))
        try:
            client = await self._get_calendar_client_async()
            found = await find_appointments(
                client=client, callback_number=callback_number,
                caller_name=caller_name, time_min=now, time_max=until,
            )
        except CalendarAuthError:
            logger.exception("find_my_appointment: auth error")
            return ("I'm having trouble accessing our calendar right now. Can I "
                    "take a message and have someone call you back?")
        except Exception:
            logger.exception("find_my_appointment: client error")
            return ("I can't look up appointments at the moment. Can I take a "
                    "message instead?")

        if not found:
            return ("I couldn't find any upcoming appointment booked with that "
                    "number. Double-check the number with the caller, or offer to "
                    "book a new appointment.")

        for appt in found:
            self._found_appointments[appt.event_id] = appt
        from receptionist.booking.booking import event_doctor, event_token
        lines = []
        for i, a in enumerate(found, start=1):
            meta = {"description": a.description}
            doc_name, tok = event_doctor(meta), event_token(meta)
            extra = (f", doctor {doc_name}" if doc_name else "") + (f", token {tok}" if tok else "")
            lines.append(
                f"{i}. {_format_friendly_date(datetime.fromisoformat(a.start_iso))} "
                f"({a.summary}{extra})  [event_id={a.event_id}]"
            )
        return (
            "Upcoming appointments for this caller. Read the time back and confirm "
            "which one they mean before cancelling or rescheduling:\n" + "\n".join(lines)
        )

    @function_tool()
    async def cancel_appointment(self, ctx: RunContext, event_id: str) -> str:
        """Cancel an appointment found by find_my_appointment, after the caller says yes.

        Args:
            event_id: the exact event_id= string from find_my_appointment.
        """
        from receptionist.booking.booking import cancel_appointment as _cancel

        if self.config.calendar is None or not self.config.calendar.enabled:
            return "Calendar booking is not enabled for this business."
        appt = self._found_appointments.get(event_id)
        if appt is None:
            return ("I need to look up the appointment first — call "
                    "find_my_appointment with the caller's phone number.")
        try:
            client = await self._get_calendar_client_async()
            await _cancel(client=client, appointment=appt,
                          call_id=self.lifecycle.metadata.call_id)
        except Exception:
            logger.exception("cancel_appointment: error")
            return ("I had trouble cancelling that. Can I take a message so "
                    "someone from the clinic confirms the cancellation?")
        self._found_appointments.pop(event_id, None)
        self.lifecycle._add_outcome("appointment_cancelled")
        when = _format_friendly_date(datetime.fromisoformat(appt.start_iso))
        return f"Done — the appointment on {when} has been cancelled."

    @function_tool()
    async def reschedule_appointment(
        self, ctx: RunContext, event_id: str, new_start_iso: str,
    ) -> str:
        """Move an existing appointment to a new time the caller picked.

        Args:
            event_id: the exact event_id= string from find_my_appointment.
            new_start_iso: the exact iso= string from a check_availability
                response that the caller confirmed.
        """
        from receptionist.booking.booking import (
            SlotNoLongerAvailableError, reschedule_appointment as _reschedule,
        )

        if self.config.calendar is None or not self.config.calendar.enabled:
            return "Calendar booking is not enabled for this business."
        appt = self._found_appointments.get(event_id)
        if appt is None:
            return ("I need to look up the appointment first — call "
                    "find_my_appointment with the caller's phone number.")
        if not self._slot_was_offered(new_start_iso):
            return ("I need to check that new time first — call "
                    "check_availability, offer the slots, then reschedule.")

        from receptionist.booking.booking import event_doctor
        doc = None
        if self._active_doctors():
            doc, _ = self._resolve_doctor(event_doctor({"description": appt.description})
                                           or self._slot_doctor.get(new_start_iso))
        start = datetime.fromisoformat(new_start_iso)
        duration = timedelta(minutes=self._calendar_for(doc).appointment_duration_minutes)
        slot = SlotProposal(start_iso=new_start_iso, end_iso=(start + duration).isoformat())
        new_token = None
        try:
            client = await self._get_calendar_client_async()
            extra = {}
            if doc is not None:
                tz = ZoneInfo(self.config.business.timezone)
                same_day = datetime.fromisoformat(appt.start_iso).astimezone(tz).date() == start.astimezone(tz).date()
                if not same_day:
                    new_token = await self._token_for(client, doc, start, ignore_event_id=appt.event_id)
                extra = {
                    "is_busy": lambda s_, e_, ignore_event_id=None: self._doctor_is_busy(
                        client, doc, s_, e_, ignore_event_id=ignore_event_id),
                    "new_token": new_token,
                }
            await _reschedule(
                client=client, appointment=appt, new_slot=slot,
                time_zone=self.config.business.timezone,
                call_id=self.lifecycle.metadata.call_id,
                **extra,
            )
        except SlotNoLongerAvailableError:
            return ("That new time was just taken. Run check_availability again "
                    "and offer the caller other times.")
        except Exception:
            logger.exception("reschedule_appointment: error")
            return ("I had trouble moving the appointment. Can I take a message "
                    "so someone from the clinic confirms the new time?")

        old_when = _format_friendly_date(datetime.fromisoformat(appt.start_iso))
        new_when = _format_friendly_date(start)
        appt.start_iso, appt.end_iso = slot.start_iso, slot.end_iso
        self.lifecycle._add_outcome("appointment_rescheduled")
        token_msg = f" Their new OPD token number is {new_token}." if new_token else ""
        return f"Done — your appointment has moved from {old_when} to {new_when}.{token_msg}"


server = AgentServer()
# Per-subprocess signaling warmup (cold-start mitigation). LiveKit recommends
# assigning lifecycle hooks directly on the AgentServer instance rather than
# passing them to the constructor. See _warm_signaling for the rationale.
server.setup_fnc = _prewarm


@server.rtc_session(agent_name=_resolve_agent_name())
async def handle_call(ctx: agents.JobContext):
    _trace_stage("handle_call_entered", getattr(getattr(ctx, "room", None), "name", "?"))
    _start_generation_watchdog_once()
    _trace_stage("after_watchdog_start", getattr(getattr(ctx, "room", None), "name", "?"))
    config = load_business_config(ctx)
    try:
        from receptionist.integrations.clinic_settings import apply_settings, fetch_settings
        config = apply_settings(config, await fetch_settings())
    except Exception:
        logger.exception("clinic settings overlay failed; using YAML config")
    _trace_stage("after_load_config", getattr(getattr(ctx, "room", None), "name", "?"))

    lifecycle = CallLifecycle(
        config=config,
        call_id=ctx.room.name,
        caller_phone=_get_caller_phone(ctx),
    )
    _trace_stage("after_lifecycle_init", lifecycle.metadata.call_id)

    logger.info(
        "callerid: handle_call snapshot caller_phone_present=%s room=%s",
        lifecycle.metadata.caller_phone is not None, ctx.room.name,
        extra={
            "call_id": lifecycle.metadata.call_id,
            "component": "agent.callerid",
            "source": "handle_call_snapshot",
            "remote_participants": [
                {
                    "identity": getattr(p, "identity", ""),
                    "kind": int(getattr(p, "kind", 0) or 0),
                    "attrs": sorted((getattr(p, "attributes", {}) or {}).keys()),
                }
                for p in ctx.room.remote_participants.values()
            ],
        },
    )

    def _handle_participant_connected(participant: rtc.RemoteParticipant) -> None:
        _capture_caller_phone_from_participant(
            lifecycle, participant, source="participant_connected",
        )

    def _handle_participant_attributes_changed(
        changed_attributes: dict[str, str], participant: rtc.RemoteParticipant,
    ) -> None:
        # SIP trunks sometimes publish caller-id attributes after the participant
        # has already joined the room (e.g. Telnyx INVITE → PRACK delay, Asterisk
        # diversion-header late update). Re-run capture if any sip.* attribute
        # changed and we don't have a phone yet.
        if lifecycle.metadata.caller_phone is not None:
            return
        if not any(k.startswith("sip.") for k in (changed_attributes or {})):
            return
        _capture_caller_phone_from_participant(
            lifecycle, participant, source="participant_attributes_changed",
        )

    ctx.room.on("participant_connected", _handle_participant_connected)
    ctx.room.on(
        "participant_attributes_changed", _handle_participant_attributes_changed,
    )
    for participant in ctx.room.remote_participants.values():
        _capture_caller_phone_from_participant(
            lifecycle, participant, source="initial_scan",
        )

    idle_cfg = config.voice.idle
    if config.voice.engine == "gemini_live":
        lc = config.voice.live
        live_kwargs = {"model": lc.model, "voice": lc.voice}
        if lc.language:
            live_kwargs["language"] = lc.language
        if lc.voice_provider == "sarvam":
            # Gemini Live returns text; Sarvam turns it into the Indian voice.
            p = config.voice.pipeline
            session = AgentSession(
                llm=google.realtime.RealtimeModel(modalities=["TEXT"], **live_kwargs),
                tts=sarvam.TTS(model=p.tts_model, target_language_code=p.tts_language,
                               speaker=p.tts_speaker),
                user_away_timeout=idle_cfg.away_seconds,
            )
        else:
            session = AgentSession(
                llm=google.realtime.RealtimeModel(**live_kwargs),
                user_away_timeout=idle_cfg.away_seconds,
            )
    elif config.voice.engine == "pipeline":
        p = config.voice.pipeline
        session = AgentSession(
            stt=sarvam.STT(model=p.stt_model, language=p.stt_language),
            llm=_build_pipeline_llm(p),
            tts=sarvam.TTS(
                model=p.tts_model,
                target_language_code=p.tts_language,
                speaker=p.tts_speaker,
            ),
            vad=silero.VAD.load(),
            user_away_timeout=idle_cfg.away_seconds,
            preemptive_generation=p.preemptive_generation,
            min_endpointing_delay=0.35,
        )
    else:
        realtime_kwargs = _build_realtime_model_kwargs(
            config.voice, api_key=await resolve_voice_bearer_async(config.voice.auth),
        )
        realtime_model = openai.realtime.RealtimeModel(**realtime_kwargs)
        _apply_realtime_options(realtime_model, config.voice)
        session = AgentSession(
            llm=realtime_model,
            # Issue #11: feed the silence-hangup `away_seconds` into LiveKit's
            # built-in user-state machine. When the caller falls silent for this
            # long, `user_state` flips to "away" and we start the grace timer.
            user_away_timeout=idle_cfg.away_seconds,
        )

    _attach_timing_log(session, lifecycle.metadata.call_id)

    # Wire transcript capture BEFORE session starts so no events are missed.
    lifecycle.attach_transcript_capture(session)

    # Build the Receptionist BEFORE wiring its event listeners so we can
    # also subscribe to session events the agent needs (issue #11).
    receptionist = Receptionist(config, lifecycle)
    _verify_tool_contract(receptionist, call_id=lifecycle.metadata.call_id)
    session.on("user_input_transcribed", receptionist._on_user_input_transcribed)
    session.on("function_tools_executed", receptionist._on_function_tools_executed)
    session.on("conversation_item_added", receptionist._on_conversation_item_added)

    # Recoverable-realtime-error safety net. When the OpenAI Realtime API
    # rejects a model response (most commonly `rate_limit_exceeded` on
    # token-rate-limited tiers), the agent would otherwise fall silent until
    # the caller speaks again. `_RealtimeRecovery` speaks a brief filler and
    # re-triggers the response. The `error` event is emitted synchronously, so
    # the async recovery is scheduled as a background task.
    _realtime_recovery = _RealtimeRecovery(session)

    def _on_session_error(error_event) -> None:
        _create_background_task(_realtime_recovery.handle_error(error_event))

    session.on("error", _on_session_error)

    # Issue #16 DTMF auto-attendant. When enabled, keypad presses are handled
    # deterministically off the LiveKit `sip_dtmf_received` event rather than
    # through the LLM. Transfers reuse receptionist._execute_transfer so the
    # intake_only gate and SIP path are shared with the voice transfer_call.
    intakes_has_dtmf = (
        config.intakes is not None
        and config.intakes.enabled
        and config.intakes.has_dtmf_questions()
    )
    menu_enabled = config.dtmf is not None and config.dtmf.enabled
    if menu_enabled or intakes_has_dtmf:
        _dtmf_sip_identity = _get_caller_identity(ctx)

        async def _dtmf_speak_goodbye() -> None:
            await _speak_goodbye_and_terminate(
                session, lifecycle, ctx, reason="caller_pressed_end_key",
            )

        _dtmf_state = _DtmfHandlerState(
            config=config,
            lifecycle=lifecycle,
            session=session,
            sip_caller_identity=_dtmf_sip_identity,
            execute_transfer=receptionist._execute_transfer,
            speak_goodbye=_dtmf_speak_goodbye,
        )
        receptionist._dtmf_state = _dtmf_state

        def _on_sip_dtmf_received(event) -> None:
            _create_background_task(_dispatch_dtmf_event(event, _dtmf_state))

        ctx.room.on("sip_dtmf_received", _on_sip_dtmf_received)

    # Issue #11 silence-timeout watchers. The primary path follows
    # LiveKit's user_state machine; the optional absolute path is a
    # wall-clock fallback for SIP comfort noise that prevents `away`.
    silence_grace_timer: asyncio.TimerHandle | None = None
    absolute_silence_timer: asyncio.TimerHandle | None = None
    silence_timeout_scheduled = False

    def _cancel_silence_grace_timer() -> None:
        nonlocal silence_grace_timer
        if silence_grace_timer is not None:
            silence_grace_timer.cancel()
            silence_grace_timer = None

    def _cancel_absolute_silence_timer() -> None:
        nonlocal absolute_silence_timer
        if absolute_silence_timer is not None:
            absolute_silence_timer.cancel()
            absolute_silence_timer = None

    def _schedule_silence_timeout(source: str, elapsed_seconds: float) -> None:
        nonlocal silence_timeout_scheduled
        if silence_timeout_scheduled:
            return
        silence_timeout_scheduled = True
        _cancel_silence_grace_timer()
        _cancel_absolute_silence_timer()
        lifecycle.record_agent_ended("silence_timeout")
        logger.warning(
            "silence_timeout: %s triggered after %.1fs, ending call",
            source,
            elapsed_seconds,
            extra={
                "call_id": lifecycle.metadata.call_id,
                "component": "agent.silence",
                "source": source,
                "elapsed_seconds": elapsed_seconds,
            },
        )

        async def _run() -> None:
            await _speak_goodbye_and_terminate(
                session, lifecycle, ctx, reason="silence_timeout",
            )

        _create_background_task(_run())

    def _on_silence_grace_expired() -> None:
        # Re-check user_state at fire time; the user may have come back.
        if session.user_state != "away":
            return
        _schedule_silence_timeout(
            "user_state",
            idle_cfg.away_seconds + idle_cfg.silence_grace_seconds,
        )

    def _on_absolute_silence_expired() -> None:
        _schedule_silence_timeout(
            "absolute",
            float(idle_cfg.absolute_silence_seconds or 0),
        )

    def _on_user_state_changed(ev) -> None:
        nonlocal silence_grace_timer
        if not idle_cfg.silence_hangup_enabled:
            return
        new_state = getattr(ev, "new_state", None)
        if new_state == "away":
            _cancel_silence_grace_timer()
            loop = asyncio.get_event_loop()
            silence_grace_timer = loop.call_later(
                idle_cfg.silence_grace_seconds, _on_silence_grace_expired,
            )
            logger.info(
                "silence_timeout: caller went away, hanging up in %.1fs unless they return",
                idle_cfg.silence_grace_seconds,
                extra={
                    "call_id": lifecycle.metadata.call_id,
                    "component": "agent.silence",
                    "grace_seconds": idle_cfg.silence_grace_seconds,
                },
            )
        else:
            _cancel_silence_grace_timer()

    session.on("user_state_changed", _on_user_state_changed)

    def _on_user_item_keepalive(ev) -> None:
        # A typed chat message means the caller is active even if silent.
        item = getattr(ev, "item", None)
        if item is not None and getattr(item, "role", None) == "user":
            _cancel_silence_grace_timer()

    session.on("conversation_item_added", _on_user_item_keepalive)

    def _on_absolute_silence_user_input(ev) -> None:
        nonlocal absolute_silence_timer
        if not idle_cfg.silence_hangup_enabled:
            return
        if not idle_cfg.absolute_silence_seconds:
            return
        if silence_timeout_scheduled:
            return
        if not _is_final_user_transcript(ev):
            return
        _cancel_absolute_silence_timer()
        loop = asyncio.get_event_loop()
        absolute_silence_timer = loop.call_later(
            idle_cfg.absolute_silence_seconds,
            _on_absolute_silence_expired,
        )

    session.on("user_input_transcribed", _on_absolute_silence_user_input)

    # Issue #11 max-duration cap. Single one-shot timer scheduled at
    # session start; cancelled by the close handler so a normal hangup
    # doesn't double-fire the goodbye.
    duration_state: dict[str, asyncio.TimerHandle | bool | None] = {
        "timer": None, "scheduled": False,
    }

    def _on_max_duration_reached() -> None:
        if duration_state["scheduled"]:
            return
        duration_state["scheduled"] = True
        lifecycle.record_agent_ended("max_duration_reached")
        logger.warning(
            "max_duration: cap of %ds reached, ending call",
            idle_cfg.max_call_duration_seconds,
            extra={
                "call_id": lifecycle.metadata.call_id,
                "component": "agent.max_duration",
            },
        )

        async def _run() -> None:
            await _speak_goodbye_and_terminate(
                session, lifecycle, ctx, reason="max_duration_reached",
            )

        _create_background_task(_run())

    if idle_cfg.max_call_duration_seconds:
        loop = asyncio.get_event_loop()
        duration_state["timer"] = loop.call_later(
            idle_cfg.max_call_duration_seconds, _on_max_duration_reached,
        )

    # Register the close handler. `close` fires when the session ends for any
    # reason. livekit's EventEmitter rejects coroutine handlers (it requires
    # plain callables), so we schedule the async work via `create_task`.
    #
    # Note on lifetime: `AgentSession.start()` below returns shortly after
    # the session is initialized, NOT after the call ends. The `@rtc_session`
    # framework keeps the job — and therefore the event loop — alive until
    # the underlying room actually closes, which is what gives the scheduled
    # task time to run. Validated manually 2026-04-24: transcript + email
    # artifacts land after disconnect even though handle_call returned
    # minutes earlier.
    def _handle_close(_event) -> None:
        # Issue #11: cancel any pending silence/duration timers so a normal
        # hangup doesn't accidentally fire goodbye-after-disconnect later.
        _cancel_silence_grace_timer()
        _cancel_absolute_silence_timer()
        timer = duration_state["timer"]
        if timer is not None:
            timer.cancel()
            duration_state["timer"] = None

        async def _run() -> None:
            try:
                await lifecycle.on_call_ended()
            except Exception:
                logger.exception("lifecycle.on_call_ended raised")

        _create_background_task(_run())

    session.on("close", _handle_close)

    # Start recording before greeting. The consent preamble (Phase 8) fires
    # before the greeting; the recording is already live by that point, so
    # the preamble is captured — which is the correct proof-of-disclosure.
    await lifecycle.start_recording_if_enabled(ctx.room.name)

    # Side-channel breadcrumb file. The shared `agent.log` stdout/stderr
    # file gets interleaved writes from multiple worker subprocesses on
    # Windows, which corrupts log lines and hides diagnostic info. Writing
    # to a per-PID file in `secrets/<business>/runtime/breadcrumbs/` is
    # atomic and gives us reliable execution traces during live-call
    # debugging.
    _trace_stage("about_to_session_start", lifecycle.metadata.call_id)
    await session.start(
        room=ctx.room,
        agent=receptionist,
        room_options=room_io.RoomOptions(
            audio_input=room_io.AudioInputOptions(
                noise_cancellation=lambda params: (
                    noise_cancellation.BVCTelephony()
                    if params.participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_SIP
                    else noise_cancellation.BVC()
                ),
            ),
        ),
    )
    _trace_stage("session_start_returned", lifecycle.metadata.call_id)
    try:
        await _refresh_realtime_tools(
            receptionist, call_id=lifecycle.metadata.call_id,
        )
    except Exception as exc:
        _trace_stage(f"refresh_realtime_tools_raised:{type(exc).__name__}:{exc!r}",
            lifecycle.metadata.call_id)
        logger.error(
            "handle_call: _refresh_realtime_tools raised; call will proceed "
            "with whatever tool registry OpenAI established during session.start",
            extra={"call_id": lifecycle.metadata.call_id, "component": "agent.setup"},
        )
    _trace_stage("setup_complete", lifecycle.metadata.call_id)


if __name__ == "__main__":
    _run_agent_cli()
