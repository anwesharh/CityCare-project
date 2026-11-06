// src/routes/webhooks.js — endpoints the AI agent calls (shared secret required)
import { Router } from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { Alert, Call, Message, Patient, Report, phoneKey } from '../models/index.js';
import { summariseCall } from '../lib/summary.js';
import { getSettings } from '../lib/settings.js';

const router = Router();

export function secretOk(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(config.webhookSecret);
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

const guard = (req, res, next) => (secretOk(req.get('x-webhook-secret')) ? next() : res.status(401).json({ error: 'bad secret' }));

/** Map the agent's payload (snake_case) to our Call document. */
export function toCallDoc(c) {
  const firstReport = (c.emergency_reports || [])[0] || {};
  const firstMsg = (c.messages || [])[0] || {};
  const callerPhone = c.caller_phone || firstReport.callback_number || firstMsg.callback_number || undefined;
  return {
    callId: c.call_id,
    channel: c.channel === 'phone' ? 'phone' : 'web',
    callerPhone,
    callerPhoneKey: phoneKey(callerPhone) || undefined,
    callerName: firstReport.caller_name || firstMsg.caller_name || undefined,
    startedAt: c.start_ts ? new Date(c.start_ts) : undefined,
    endedAt: c.end_ts ? new Date(c.end_ts) : undefined,
    durationSeconds: c.duration_seconds ?? undefined,
    outcomes: c.outcomes || [],
    appointment: c.appointment_details || undefined,
    faqsAnswered: c.faqs_answered || [],
    languages: c.languages_detected || [],
    endReason: c.agent_end_reason || undefined,
    urgent: Boolean(c.urgent),
    urgentKeywords: c.urgent_keywords || [],
    emergencyReports: c.emergency_reports || [],
    transcript: (c.transcript || []).map((t) => ({
      role: t.role, text: t.text, at: t.at ? new Date(t.at) : undefined, toolOutput: t.tool_output,
    })),
  };
}

/** Remember a patient (by phone) whenever we learn their number. */
export async function touchPatient({ phone, name, at }) {
  const key = phoneKey(phone);
  if (key.length < 7) return;
  const update = { $set: { phone, lastSeenAt: at || new Date() } };
  if (name) update.$set.name = name;
  await Patient.updateOne({ phoneKey: key }, { ...update, $setOnInsert: { phoneKey: key } }, { upsert: true });
}

router.get('/settings', guard, async (_req, res, next) => {
  try { res.json({ settings: await getSettings() }); } catch (e) { next(e); }
});

/** Live emergency alert from the agent, sent the moment emergency words are heard. */
export async function saveAlert(a) {
  const report = a.report || {};
  const update = {
    $setOnInsert: { callId: a.call_id, at: a.at ? new Date(a.at) : new Date() },
    $addToSet: { keywords: { $each: (a.keywords || []).map(String).slice(0, 20) } },
    $set: {},
  };
  if (report.symptoms) update.$set.symptoms = String(report.symptoms).slice(0, 500);
  if (report.caller_name) update.$set.callerName = String(report.caller_name).slice(0, 100);
  const phone = report.callback_number || a.caller_phone;
  if (phone) update.$set.callerPhone = String(phone).slice(0, 30);
  if (!Object.keys(update.$set).length) delete update.$set;
  return Alert.findOneAndUpdate({ callId: a.call_id }, update, { upsert: true, new: true });
}

/** Agent asks "is the report ready?" — returns only test name + status, never results. */
router.post('/report-status', guard, async (req, res, next) => {
  try {
    const key = phoneKey(req.body?.phone);
    if (key.length < 10) return res.json({ reports: [] });
    const rid = String(req.body?.report_id || '').trim();
    const filter = { phoneKey: key, ...(rid ? { reportNo: rid } : {}) };
    let reports = await Report.find(filter).sort({ createdAt: -1 }).limit(6).lean();
    if (!reports.length && rid) reports = await Report.find({ phoneKey: key }).sort({ createdAt: -1 }).limit(6).lean();
    const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : '');
    const settings = await getSettings();
    res.json({
      reports: reports.map((r) => ({ test: r.test, status: r.status, date: fmt(r.createdAt),
        expected: r.expectedOn ? fmt(`${r.expectedOn}T12:00:00+05:30`) : '' })),
      collect: settings.lab?.collectInfo || '',
    });
  } catch (e) { next(e); }
});

router.post('/agent', guard, async (req, res, next) => {
  try {
    const { type, call } = req.body || {};
    if (type === 'emergency_alert' && req.body.alert?.call_id) {
      const saved = await saveAlert(req.body.alert);
      return res.json({ ok: true, id: saved._id });
    }
    if (type !== 'call_ended' || !call?.call_id) return res.status(400).json({ error: 'unsupported payload' });

    const doc = toCallDoc(call);
    const saved = await Call.findOneAndUpdate({ callId: doc.callId }, doc, { upsert: true, new: true });

    await Message.deleteMany({ callId: doc.callId });
    if ((call.messages || []).length) {
      await Message.insertMany(call.messages.map((m) => ({
        callId: doc.callId,
        callerName: m.caller_name,
        callbackNumber: m.callback_number,
        callbackKey: phoneKey(m.callback_number) || undefined,
        text: m.message,
        receivedAt: m.timestamp ? new Date(m.timestamp) : doc.endedAt || new Date(),
      })));
    }
    if (doc.callerPhone) await touchPatient({ phone: doc.callerPhone, name: doc.callerName, at: doc.startedAt });
    for (const m of call.messages || []) await touchPatient({ phone: m.callback_number, name: m.caller_name, at: doc.startedAt });

    res.json({ ok: true, id: saved._id });

    summariseCall(saved).then((summary) => (summary ? Call.updateOne({ _id: saved._id }, { summary }) : null))
      .catch((e) => console.error('[summary] failed:', e.message));
  } catch (e) { next(e); }
});

export default router;
