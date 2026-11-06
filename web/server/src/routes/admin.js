// src/routes/admin.js — staff API used by the dashboard (login required)
import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth, requireRole } from '../lib/auth.js';
import { Call, Message } from '../models/index.js';
import {
  calendarConfigured, cancelAppointment, listAppointments, rescheduleAppointment, sameDoctor,
} from '../lib/calendar.js';
import { config } from '../config.js';

const router = Router();
router.use(requireAuth);
// Lab staff only work with reports, the lab queue and appointments.
router.use(['/calls', '/messages'], requireRole('admin', 'staff', 'doctor'));

/** Start/end of a clinic day (default today) in the clinic timezone, as UTC Dates. */
export function dayRange(dateStr, tz = config.calendar.timezone) {
  const base = dateStr ? new Date(`${dateStr}T12:00:00Z`) : new Date();
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(base);
  const offsetMin = tzOffsetMinutes(tz, new Date(`${ymd}T12:00:00Z`));
  const start = new Date(Date.parse(`${ymd}T00:00:00Z`) - offsetMin * 60000);
  return { start, end: new Date(start.getTime() + 24 * 3600 * 1000), ymd };
}

export function tzOffsetMinutes(tz, at) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - at.getTime()) / 60000);
}

const isId = (id) => mongoose.isValidObjectId(id);
/** Doctors only see their own appointments. */
const doctorScope = (req) => (req.user?.role === 'doctor' ? (req.user.doctorName || '__none__') : null);

// ---------- dashboard ----------
router.get('/dashboard', async (req, res, next) => {
  try {
    const { start, end, ymd } = dayRange(req.query.date);
    const [callsToday, openMessages, urgentOpen, recentMessages, outcomeCounts] = await Promise.all([
      Call.countDocuments({ startedAt: { $gte: start, $lt: end } }),
      Message.countDocuments({ status: 'open' }),
      Call.find({ urgent: true, followedUp: false }).sort({ startedAt: -1 }).limit(5)
        .select('callId startedAt callerPhone callerName urgentKeywords summary'),
      Message.find({ status: 'open' }).sort({ receivedAt: -1 }).limit(5),
      Call.aggregate([
        { $match: { startedAt: { $gte: start, $lt: end } } },
        { $unwind: '$outcomes' },
        { $group: { _id: '$outcomes', n: { $sum: 1 } } },
      ]),
    ]);
    const counts = Object.fromEntries(outcomeCounts.map((o) => [o._id, o.n]));

    let appointments = [];
    let calendarError = null;
    if (calendarConfigured()) {
      try { appointments = await listAppointments({ from: start, to: end, doctor: doctorScope(req) }); }
      catch (e) { calendarError = e.message; }
    } else {
      calendarError = 'Google Calendar not connected';
    }

    res.json({
      date: ymd,
      stats: {
        callsToday,
        bookedToday: counts.appointment_booked || 0,
        changedToday: (counts.appointment_cancelled || 0) + (counts.appointment_rescheduled || 0),
        openMessages,
        appointmentsToday: appointments.length,
      },
      urgent: urgentOpen,
      appointments,
      calendarError,
      messages: recentMessages,
    });
  } catch (e) { next(e); }
});

// ---------- appointments (Google Calendar) ----------
router.get('/appointments', async (req, res, next) => {
  try {
    const from = req.query.from ? dayRange(req.query.from).start : dayRange().start;
    const to = req.query.to ? dayRange(req.query.to).end : new Date(from.getTime() + 30 * 24 * 3600 * 1000);
    const doctor = doctorScope(req) || (req.query.doctor || undefined);
    res.json({ appointments: await listAppointments({ from, to, q: req.query.q, doctor }) });
  } catch (e) { next(e); }
});

async function assertMayTouch(req, id) {
  const scope = doctorScope(req);
  if (!scope) return;
  const now = new Date();
  const items = await listAppointments({ from: new Date(now.getTime() - 86400000), to: new Date(now.getTime() + 90 * 86400000) });
  const appt = items.find((a) => a.id === id);
  if (!appt || !sameDoctor(appt.doctor, scope)) {
    const err = new Error('You can only change your own appointments'); err.status = 403; throw err;
  }
}

router.delete('/appointments/:id', async (req, res, next) => {
  try { await assertMayTouch(req, req.params.id); await cancelAppointment(req.params.id); res.json({ ok: true }); }
  catch (e) { next(e); }
});

router.patch('/appointments/:id', async (req, res, next) => {
  try {
    await assertMayTouch(req, req.params.id);
    res.json({ appointment: await rescheduleAppointment(req.params.id, req.body?.start, req.user?.name) });
  } catch (e) { next(e); }
});

// ---------- calls ----------
router.get('/calls', async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.urgent === 'true') filter.urgent = true;
    if (req.query.q) {
      const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ callerName: rx }, { callerPhone: rx }, { summary: rx }];
    }
    const page = Math.max(1, Number(req.query.page) || 1);
    const [items, total] = await Promise.all([
      Call.find(filter).sort({ startedAt: -1 }).skip((page - 1) * 25).limit(25).select('-transcript'),
      Call.countDocuments(filter),
    ]);
    res.json({ calls: items, total, page });
  } catch (e) { next(e); }
});

router.get('/calls/:id', async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const call = await Call.findById(req.params.id);
    if (!call) return res.status(404).json({ error: 'Not found' });
    const messages = await Message.find({ callId: call.callId });
    return res.json({ call, messages });
  } catch (e) { return next(e); }
});

router.patch('/calls/:id', async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const call = await Call.findByIdAndUpdate(req.params.id,
      { followedUp: Boolean(req.body?.followedUp) }, { new: true }).select('-transcript');
    return call ? res.json({ call }) : res.status(404).json({ error: 'Not found' });
  } catch (e) { return next(e); }
});

// ---------- messages ----------
router.get('/messages', async (req, res, next) => {
  try {
    const status = req.query.status === 'done' ? 'done' : req.query.status === 'all' ? undefined : 'open';
    const messages = await Message.find(status ? { status } : {}).sort({ receivedAt: -1 }).limit(200);
    res.json({ messages });
  } catch (e) { next(e); }
});

router.patch('/messages/:id', async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const status = req.body?.status === 'done' ? 'done' : 'open';
    const msg = await Message.findByIdAndUpdate(req.params.id, { status }, { new: true });
    return msg ? res.json({ message: msg }) : res.status(404).json({ error: 'Not found' });
  } catch (e) { return next(e); }
});

export default router;
