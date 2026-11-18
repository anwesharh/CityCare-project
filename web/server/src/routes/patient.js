// src/routes/patient.js — patient portal: email-code login, appointments, reports, prescriptions
import { Router } from 'express';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import { Patient, Prescription, Report, phoneKey } from '../models/index.js';
import { hashCode, newCode, requirePatient, sameHash, signPatientToken } from '../lib/patientAuth.js';
import { emailConfigured, maskEmail, sendLoginCode } from '../lib/mailer.js';
import { receiveFile, sendFile, deleteFile } from '../lib/files.js';
import { applyEdits, createPrescription, publicRx, retryPrescription } from '../lib/prescriptions.js';
import { prescriptionToIcs } from '../lib/ics.js';
import { getSettings } from '../lib/settings.js';
import { getQueue } from '../lib/queue.js';
import { sameDoctor } from '../lib/calendar.js';
import { appointmentsByPhone, calendarWindow } from './insights.js';

const router = Router();
const isId = (id) => mongoose.isValidObjectId(id);
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in 15 minutes.' } });

// ---------- login ----------
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

/**
 * Step 1 of login. If the number already has an email, the code goes there.
 * If not, the patient gives their email (sign-up) and the code goes to that email;
 * it is saved only after they type the right code.
 */
router.post('/request-code', loginLimiter, async (req, res, next) => {
  try {
    const key = phoneKey(req.body?.phone);
    if (key.length < 10) return res.status(400).json({ error: 'Enter your 10-digit mobile number' });
    let patient = await Patient.findOne({ phoneKey: key });
    const given = String(req.body?.email || '').trim().toLowerCase();
    let sendTo = patient?.email;
    let signup = false;
    if (!sendTo) {
      if (!given) return res.json({ needsEmail: true });
      if (!EMAIL_RE.test(given)) return res.status(400).json({ error: 'Enter a valid email address' });
      sendTo = given;
      signup = true;
    }
    if (patient?.otpSentAt && Date.now() - patient.otpSentAt.getTime() < 60000) {
      return res.status(429).json({ error: 'A code was just sent. Wait a minute before asking again.' });
    }
    if (!patient) {
      patient = new Patient({ phoneKey: key, phone: String(req.body.phone).trim().slice(0, 30),
        name: String(req.body?.name || '').trim().slice(0, 120) || undefined });
    } else if (signup && !patient.name && req.body?.name) {
      patient.name = String(req.body.name).trim().slice(0, 120);
    }
    const code = newCode();
    patient.otpHash = hashCode(key, code);
    patient.otpExpires = new Date(Date.now() + 10 * 60000);
    patient.otpTries = 0;
    patient.otpSentAt = new Date();
    patient.otpEmail = signup ? sendTo : undefined;
    await patient.save();
    const settings = await getSettings();
    let r;
    try { r = await sendLoginCode(sendTo, code, settings.clinicName || 'CityCare'); }
    catch (err) {
      console.error('[patient-login] email failed:', err.message);
      patient.otpSentAt = undefined; await patient.save();
      return res.status(502).json({ error: "Couldn't send the email right now. Please try again in a few minutes." });
    }
    return res.json({ sentTo: maskEmail(sendTo), devMode: r.dev, signup });
  } catch (e) { return next(e); }
});

router.post('/verify', loginLimiter, async (req, res, next) => {
  try {
    const key = phoneKey(req.body?.phone);
    const code = String(req.body?.code || '').replace(/\D/g, '');
    const patient = await Patient.findOne({ phoneKey: key });
    const bad = () => res.status(400).json({ error: 'That code is wrong or has expired' });
    if (!patient?.otpHash || !patient.otpExpires || patient.otpExpires < new Date()) return bad();
    if (patient.otpTries >= 5) return res.status(429).json({ error: 'Too many wrong codes. Ask for a new one.' });
    if (!sameHash(patient.otpHash, hashCode(key, code))) {
      patient.otpTries += 1; await patient.save(); return bad();
    }
    if (patient.otpEmail && !patient.email) patient.email = patient.otpEmail; // sign-up: email is now verified
    patient.otpHash = undefined; patient.otpExpires = undefined; patient.otpTries = 0; patient.otpEmail = undefined;
    patient.portalLastLogin = new Date();
    await patient.save();
    return res.json({ token: signPatientToken(key), name: patient.name || '' });
  } catch (e) { return next(e); }
});

router.get('/config', (_req, res) => res.json({ emailConfigured: emailConfigured() }));

// ---------- everything below needs a patient login ----------
router.use(requirePatient);

router.get('/me', async (req, res, next) => {
  try {
    const key = req.patientKey;
    const patient = await Patient.findOne({ phoneKey: key }).lean();
    if (!patient) return res.status(404).json({ error: 'Not found' });
    let appointments = [];
    let calendarError = null;
    try { appointments = appointmentsByPhone(await calendarWindow(365, 120)).get(key) || []; }
    catch (e) { calendarError = 'Appointments are not available right now'; console.error('[patient] calendar:', e.message); }
    const now = Date.now();
    const upcoming = appointments.filter((a) => new Date(a.end || a.start).getTime() >= now);
    const past = appointments.filter((a) => new Date(a.end || a.start).getTime() < now).reverse().slice(0, 30);

    // live queue position for today's appointments
    let queue = null;
    try { queue = await getQueue(); } catch { /* queue optional */ }
    const today = queue?.date;
    const withQueue = upcoming.map((a) => {
      const ymd = new Date(new Date(a.start).getTime() + 330 * 60000).toISOString().slice(0, 10);
      const q = today === ymd && a.token ? queue.items.find((i) => sameDoctor(i.doctor, a.doctor)) : null;
      return {
        id: a.id, start: a.start, end: a.end, doctor: a.doctor, token: a.token, status: a.status,
        queue: q ? { nowServing: q.nowServing, ahead: Math.max(0, a.token - q.nowServing - 1), room: q.room, done: q.nowServing >= a.token } : null,
      };
    });
    const [reports, prescriptions] = await Promise.all([
      Report.find({ phoneKey: key }).sort({ createdAt: -1 }).limit(50).lean(),
      Prescription.find({ phoneKey: key }).sort({ createdAt: -1 }).limit(50),
    ]);
    const settings = await getSettings();
    return res.json({
      patient: { name: patient.name || '', phone: patient.phone || '', email: maskEmail(patient.email) },
      clinic: { name: settings.clinicName, collectInfo: settings.lab?.collectInfo || '' },
      upcoming: withQueue,
      past: past.map((a) => ({ id: a.id, start: a.start, doctor: a.doctor, token: a.token })),
      calendarError,
      reports: reports.map((r) => ({ _id: r._id, test: r.test, status: r.status, reportNo: r.reportNo, createdAt: r.createdAt,
        readyAt: r.readyAt, expectedOn: r.expectedOn,
        file: r.file?.id && r.status !== 'processing' ? { name: r.file.name, contentType: r.file.contentType } : null })),
      prescriptions: prescriptions.map(publicRx),
    });
  } catch (e) { return next(e); }
});

// report file (only when it belongs to this patient and is marked ready/collected)
router.get('/reports/:id/file', async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const r = await Report.findOne({ _id: req.params.id, phoneKey: req.patientKey }).lean();
    if (!r?.file?.id || r.status === 'processing') return res.status(404).json({ error: 'Not available yet' });
    return sendFile(res, r.file);
  } catch (e) { return next(e); }
});

// prescriptions
router.post('/prescriptions', receiveFile, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a photo or PDF of the prescription' });
    const count = await Prescription.countDocuments({ phoneKey: req.patientKey });
    if (count >= 100) return res.status(400).json({ error: 'You have reached the limit of 100 prescriptions' });
    const patient = await Patient.findOne({ phoneKey: req.patientKey }).lean();
    const rx = await createPrescription(req.file, { phoneKey: req.patientKey, patientName: patient?.name, source: 'patient', uploadedBy: 'patient' });
    return res.status(201).json({ prescription: publicRx(rx) });
  } catch (e) { return next(e); }
});

async function ownRx(req, res) {
  if (!isId(req.params.id)) { res.status(404).json({ error: 'Not found' }); return null; }
  const rx = await Prescription.findOne({ _id: req.params.id, phoneKey: req.patientKey });
  if (!rx) res.status(404).json({ error: 'Not found' });
  return rx;
}

router.get('/prescriptions/:id', async (req, res, next) => {
  try { const rx = await ownRx(req, res); if (rx) res.json({ prescription: publicRx(rx) }); } catch (e) { next(e); }
});
router.patch('/prescriptions/:id', async (req, res, next) => {
  try {
    const rx = await ownRx(req, res); if (!rx) return undefined;
    applyEdits(rx, req.body); await rx.save();
    return res.json({ prescription: publicRx(rx) });
  } catch (e) { return next(e); }
});
router.post('/prescriptions/:id/retry', async (req, res, next) => {
  try { const rx = await ownRx(req, res); if (rx) res.json({ prescription: publicRx(await retryPrescription(rx)) }); } catch (e) { next(e); }
});
router.delete('/prescriptions/:id', async (req, res, next) => {
  try {
    const rx = await ownRx(req, res); if (!rx) return undefined;
    if (rx.source === 'staff') return res.status(403).json({ error: 'Prescriptions added by the hospital can only be removed by the hospital' });
    await deleteFile(rx.file?.id); await rx.deleteOne();
    return res.json({ ok: true });
  } catch (e) { return next(e); }
});
router.get('/prescriptions/:id/file', async (req, res, next) => {
  try { const rx = await ownRx(req, res); if (rx?.file?.id) sendFile(res, rx.file); else if (rx) res.status(404).json({ error: 'No file' }); } catch (e) { next(e); }
});
router.get('/prescriptions/:id/reminders.ics', async (req, res, next) => {
  try {
    const rx = await ownRx(req, res); if (!rx) return undefined;
    const settings = await getSettings();
    const startDate = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="medicine-reminders.ics"');
    return res.send(prescriptionToIcs(rx, { clinicName: settings.clinicName, startDate }));
  } catch (e) { return next(e); }
});

export default router;
