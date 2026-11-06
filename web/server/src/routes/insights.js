// src/routes/insights.js — patients, analytics and live calls (login required)
import { Router } from 'express';
import crypto from 'node:crypto';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { requireAuth, requireRole } from '../lib/auth.js';
import { Call, Message, Patient, phoneKey } from '../models/index.js';
import { calendarConfigured, listAppointments } from '../lib/calendar.js';
import { config } from '../config.js';

const router = Router();
router.use(requireAuth);
router.use('/patients', requireRole('admin', 'staff', 'doctor'));
const DAY = 86400000;

// ---------- patients ----------
/** Group calendar appointments by patient phone. */
export function appointmentsByPhone(appointments) {
  const map = new Map();
  for (const a of appointments) {
    const key = phoneKey(a.phone);
    if (key.length < 7) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(a);
  }
  return map;
}

async function calendarWindow(pastDays = 180, futureDays = 60) {
  if (!calendarConfigured()) return [];
  const now = Date.now();
  try { return await listAppointments({ from: new Date(now - pastDays * DAY), to: new Date(now + futureDays * DAY) }); }
  catch { return []; }
}

router.get('/patients', async (req, res, next) => {
  try {
    const appts = await calendarWindow();
    const byPhone = appointmentsByPhone(appts);
    // Make sure everyone who booked is in the patient list.
    for (const [key, list] of byPhone) {
      const latest = list[list.length - 1];
      await Patient.updateOne({ phoneKey: key },
        { $setOnInsert: { phoneKey: key, phone: latest.phone, name: latest.patientName, lastSeenAt: new Date(latest.start) } },
        { upsert: true });
    }
    const q = String(req.query.q || '').trim();
    const filter = {};
    if (q) {
      const digits = q.replace(/\D/g, '');
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, ...(digits.length >= 3 ? [{ phoneKey: new RegExp(digits) }] : [])];
    }
    const patients = await Patient.find(filter).sort({ lastSeenAt: -1 }).limit(300).lean();
    const callCounts = Object.fromEntries((await Call.aggregate([
      { $match: { callerPhoneKey: { $in: patients.map((p) => p.phoneKey) } } },
      { $group: { _id: '$callerPhoneKey', n: { $sum: 1 } } },
    ])).map((c) => [c._id, c.n]));
    const now = Date.now();
    res.json({
      patients: patients.map((p) => {
        const list = byPhone.get(p.phoneKey) || [];
        const upcoming = list.filter((a) => new Date(a.start).getTime() >= now);
        return { ...p, calls: callCounts[p.phoneKey] || 0, visits: list.length - upcoming.length,
          nextAppointment: upcoming[0] || null };
      }),
    });
  } catch (e) { next(e); }
});

router.get('/patients/:key', async (req, res, next) => {
  try {
    const key = phoneKey(req.params.key);
    const patient = await Patient.findOne({ phoneKey: key }).lean();
    if (!patient) return res.status(404).json({ error: 'Not found' });
    const [calls, messages, appts] = await Promise.all([
      Call.find({ callerPhoneKey: key }).sort({ startedAt: -1 }).select('-transcript').limit(100),
      Message.find({ callbackKey: key }).sort({ receivedAt: -1 }).limit(100),
      calendarWindow(365, 90),
    ]);
    res.json({ patient, calls, messages, appointments: (appointmentsByPhone(appts).get(key) || []).reverse() });
  } catch (e) { next(e); }
});

router.patch('/patients/:key', async (req, res, next) => {
  try {
    const key = phoneKey(req.params.key);
    const $set = {};
    if (typeof req.body?.notes === 'string') $set.notes = req.body.notes.slice(0, 5000);
    if (typeof req.body?.name === 'string' && req.body.name.trim()) $set.name = req.body.name.trim().slice(0, 120);
    if (typeof req.body?.email === 'string') $set.email = req.body.email.trim().slice(0, 200);
    const patient = await Patient.findOneAndUpdate({ phoneKey: key }, { $set }, { new: true });
    return patient ? res.json({ patient }) : res.status(404).json({ error: 'Not found' });
  } catch (e) { return next(e); }
});

// ---------- analytics ----------
router.get('/analytics', requireRole('admin', 'staff'), async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
    const tz = config.calendar.timezone;
    const since = new Date(Date.now() - days * DAY);
    const match = { $match: { startedAt: { $gte: since } } };
    const [perDay, perHour, outcomes, languages, faqs, totals, channels] = await Promise.all([
      Call.aggregate([match, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$startedAt', timezone: tz } }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
      Call.aggregate([match, { $group: { _id: { $hour: { date: '$startedAt', timezone: tz } }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
      Call.aggregate([match, { $unwind: '$outcomes' }, { $group: { _id: '$outcomes', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
      Call.aggregate([match, { $unwind: '$languages' }, { $group: { _id: '$languages', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
      Call.aggregate([match, { $unwind: '$faqsAnswered' }, { $group: { _id: '$faqsAnswered', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 8 }]),
      Call.aggregate([match, { $group: { _id: null, calls: { $sum: 1 }, urgent: { $sum: { $cond: ['$urgent', 1, 0] } }, avgDuration: { $avg: '$durationSeconds' } } }]),
      Call.aggregate([match, { $group: { _id: '$channel', n: { $sum: 1 } } }]),
    ]);

    // Fill missing days with zero so the chart has a continuous axis.
    const dayMap = Object.fromEntries(perDay.map((d) => [d._id, d.n]));
    const series = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(Date.now() - i * DAY));
      series.push({ date: ymd, calls: dayMap[ymd] || 0 });
    }
    const hourMap = Object.fromEntries(perHour.map((h) => [h._id, h.n]));

    const appts = await calendarWindow(days, 0);
    const byDoctor = {};
    for (const a of appts) byDoctor[a.doctor || 'Not assigned'] = (byDoctor[a.doctor || 'Not assigned'] || 0) + 1;
    const t = totals[0] || { calls: 0, urgent: 0, avgDuration: 0 };
    const booked = outcomes.find((o) => o._id === 'appointment_booked')?.n || 0;

    res.json({
      days,
      totals: { calls: t.calls, urgent: t.urgent, avgDurationSeconds: Math.round(t.avgDuration || 0),
        bookingRate: t.calls ? Math.round((booked / t.calls) * 100) : 0, appointments: appts.length },
      perDay: series,
      perHour: Array.from({ length: 24 }, (_, h) => ({ hour: h, calls: hourMap[h] || 0 })),
      outcomes: outcomes.map((o) => ({ outcome: o._id, n: o.n })),
      languages: languages.map((l) => ({ language: l._id, n: l.n })),
      topQuestions: faqs.map((f) => ({ question: f._id, n: f.n })),
      channels: channels.map((c) => ({ channel: c._id, n: c.n })),
      appointmentsByDoctor: Object.entries(byDoctor).map(([doctor, n]) => ({ doctor, n })).sort((a, b) => b.n - a.n),
    });
  } catch (e) { next(e); }
});

// ---------- live calls ----------
const httpUrl = (u) => String(u || '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
let roomClient;
const rooms = () => {
  roomClient ||= new RoomServiceClient(httpUrl(config.livekit.url), config.livekit.apiKey, config.livekit.apiSecret);
  return roomClient;
};

router.get('/live', requireRole('admin', 'staff'), async (_req, res, next) => {
  try {
    const list = await rooms().listRooms();
    const active = list.filter((r) => r.numParticipants > 0 && /^(web-|call-|console-)/.test(r.name));
    const detailed = await Promise.all(active.map(async (r) => {
      const people = await rooms().listParticipants(r.name).catch(() => []);
      const caller = people.find((p) => !String(p.identity).startsWith('agent') && !String(p.identity).startsWith('staff-') && p.kind !== 4);
      return {
        room: r.name,
        startedAt: r.creationTime ? new Date(Number(r.creationTime) * 1000) : null,
        participants: r.numParticipants,
        caller: caller ? (caller.name || caller.identity) : null,
        channel: r.name.startsWith('web-') ? 'web' : 'phone',
      };
    }));
    res.json({ calls: detailed });
  } catch (e) { next(e); }
});

/** Hidden, listen-only token so staff can follow a live call. */
router.post('/live/:room/watch', requireRole('admin', 'staff'), async (req, res, next) => {
  try {
    const room = String(req.params.room);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(room)) return res.status(400).json({ error: 'Bad room' });
    const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
      identity: `staff-${crypto.randomUUID().slice(0, 8)}`, name: req.user.name || 'Staff', ttl: '30m',
    });
    at.addGrant({ room, roomJoin: true, canSubscribe: true, canPublish: false, canPublishData: false, hidden: true });
    res.json({ token: await at.toJwt(), url: config.livekit.url, room });
  } catch (e) { next(e); }
});

export default router;
