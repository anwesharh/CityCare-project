// src/routes/hospital.js — OPD queue, beds, lab reports and live emergency alerts (login required)
import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth, requireRole } from '../lib/auth.js';
import { Alert, Report, phoneKey } from '../models/index.js';
import { getSettings, saveBeds } from '../lib/settings.js';
import { getQueue, moveQueue } from '../lib/queue.js';
import { sameDoctor } from '../lib/calendar.js';

const router = Router();
router.use(requireAuth);
const isId = (id) => mongoose.isValidObjectId(id);

// ---------- OPD queue ----------
router.get('/queue', async (req, res, next) => {
  try {
    const q = await getQueue();
    if (req.user.role === 'doctor') q.items = q.items.filter((i) => sameDoctor(i.doctor, req.user.doctorName));
    if (req.user.role === 'lab') q.items = q.items.filter((i) => i.department === 'Diagnostics');
    res.json(q);
  } catch (e) { next(e); }
});

router.post('/queue', async (req, res, next) => {
  try {
    const { doctor, action, value } = req.body || {};
    if (!doctor || !['next', 'prev', 'set', 'reset'].includes(action)) return res.status(400).json({ error: 'Bad request' });
    if (req.user.role === 'doctor' && !sameDoctor(doctor, req.user.doctorName)) {
      return res.status(403).json({ error: 'You can only move your own queue' });
    }
    return res.json({ doctor, nowServing: await moveQueue(String(doctor), action, value) });
  } catch (e) { return next(e); }
});

// ---------- beds (staff can update counts without full settings access) ----------
router.get('/beds', async (_req, res, next) => {
  try { const s = await getSettings(); res.json({ beds: s.beds || [], updatedAt: s.bedsUpdatedAt || null }); } catch (e) { next(e); }
});
router.put('/beds', requireRole('admin', 'staff'), async (req, res, next) => {
  try { const s = await saveBeds(req.body?.beds); res.json({ beds: s.beds, updatedAt: s.bedsUpdatedAt }); } catch (e) { next(e); }
});

// ---------- lab / radiology reports ----------
const reportRoles = requireRole('admin', 'staff', 'lab');
const STATUSES = ['processing', 'ready', 'collected'];
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

router.get('/reports', reportRoles, async (req, res, next) => {
  try {
    const filter = {};
    if (STATUSES.includes(req.query.status)) filter.status = req.query.status;
    const q = str(req.query.q, 60);
    if (q) {
      const digits = q.replace(/\D/g, '');
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ patientName: rx }, { test: rx }, { reportNo: rx }, ...(digits.length >= 4 ? [{ phoneKey: { $regex: digits } }] : [])];
    }
    const reports = await Report.find(filter).sort({ createdAt: -1 }).limit(300).lean();
    const counts = Object.fromEntries(await Promise.all(STATUSES.map(async (s) => [s, await Report.countDocuments({ status: s })])));
    res.json({ reports, counts });
  } catch (e) { next(e); }
});

router.post('/reports', reportRoles, async (req, res, next) => {
  try {
    const b = req.body || {};
    const phone = str(b.phone, 30);
    if (!str(b.patientName) || !str(b.test) || phoneKey(phone).length < 10) {
      return res.status(400).json({ error: 'Patient name, a 10-digit phone number and the test are required' });
    }
    const report = await Report.create({
      reportNo: str(b.reportNo, 40) || undefined, patientName: str(b.patientName), phone, phoneKey: phoneKey(phone),
      test: str(b.test), expectedOn: /^\d{4}-\d{2}-\d{2}$/.test(b.expectedOn || '') ? b.expectedOn : undefined,
      status: STATUSES.includes(b.status) ? b.status : 'processing', notes: str(b.notes, 500),
      readyAt: b.status === 'ready' ? new Date() : undefined, updatedBy: req.user.name || req.user.email,
    });
    return res.status(201).json({ report });
  } catch (e) { return next(e); }
});

router.patch('/reports/:id', reportRoles, async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const r = await Report.findById(req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    if (STATUSES.includes(b.status) && b.status !== r.status) {
      r.status = b.status;
      if (b.status === 'ready') r.readyAt = new Date();
      if (b.status === 'collected') r.collectedAt = new Date();
    }
    for (const k of ['patientName', 'test', 'reportNo', 'notes']) if (b[k] !== undefined) r[k] = str(b[k], k === 'notes' ? 500 : 200);
    if (b.phone !== undefined) { r.phone = str(b.phone, 30); r.phoneKey = phoneKey(r.phone); }
    if (b.expectedOn !== undefined) r.expectedOn = /^\d{4}-\d{2}-\d{2}$/.test(b.expectedOn) ? b.expectedOn : undefined;
    r.updatedBy = req.user.name || req.user.email;
    await r.save();
    return res.json({ report: r });
  } catch (e) { return next(e); }
});

router.delete('/reports/:id', requireRole('admin', 'lab'), async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    await Report.deleteOne({ _id: req.params.id });
    return res.json({ ok: true });
  } catch (e) { return next(e); }
});

// ---------- live emergency alerts ----------
router.get('/alerts', async (req, res, next) => {
  try {
    const filter = req.query.open ? { acknowledgedAt: null } : {};
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const alerts = await Alert.find({ ...filter, at: { $gte: since } }).sort({ at: -1 }).limit(20).lean();
    res.json({ alerts });
  } catch (e) { next(e); }
});

router.post('/alerts/:id/ack', async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const alert = await Alert.findByIdAndUpdate(req.params.id,
      { acknowledgedBy: req.user.name || req.user.email, acknowledgedAt: new Date() }, { new: true });
    return alert ? res.json({ alert }) : res.status(404).json({ error: 'Not found' });
  } catch (e) { return next(e); }
});

export default router;
