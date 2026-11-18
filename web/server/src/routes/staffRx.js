// src/routes/staffRx.js — staff and doctors: a patient's prescriptions (view, upload for them, edit)
import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth, requireRole } from '../lib/auth.js';
import { Patient, Prescription, phoneKey } from '../models/index.js';
import { deleteFile, receiveFile, sendFile } from '../lib/files.js';
import { applyEdits, createPrescription, publicRx, retryPrescription } from '../lib/prescriptions.js';

const router = Router();
router.use(requireAuth, requireRole('admin', 'staff', 'doctor'));
const isId = (id) => mongoose.isValidObjectId(id);

router.get('/patients/:key/prescriptions', async (req, res, next) => {
  try {
    const list = await Prescription.find({ phoneKey: phoneKey(req.params.key) }).sort({ createdAt: -1 }).limit(100);
    res.json({ prescriptions: list.map(publicRx) });
  } catch (e) { next(e); }
});

router.post('/patients/:key/prescriptions', receiveFile, async (req, res, next) => {
  try {
    const key = phoneKey(req.params.key);
    const patient = await Patient.findOne({ phoneKey: key }).lean();
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
    if (!req.file) return res.status(400).json({ error: 'Choose a photo or PDF' });
    const rx = await createPrescription(req.file, { phoneKey: key, patientName: patient.name, source: 'staff',
      uploadedBy: req.user.name || req.user.email });
    return res.status(201).json({ prescription: publicRx(rx) });
  } catch (e) { return next(e); }
});

async function findRx(req, res) {
  if (!isId(req.params.id)) { res.status(404).json({ error: 'Not found' }); return null; }
  const rx = await Prescription.findById(req.params.id);
  if (!rx) res.status(404).json({ error: 'Not found' });
  return rx;
}

router.patch('/prescriptions/:id', async (req, res, next) => {
  try { const rx = await findRx(req, res); if (rx) { applyEdits(rx, req.body); await rx.save(); res.json({ prescription: publicRx(rx) }); } } catch (e) { next(e); }
});
router.post('/prescriptions/:id/retry', async (req, res, next) => {
  try { const rx = await findRx(req, res); if (rx) res.json({ prescription: publicRx(await retryPrescription(rx)) }); } catch (e) { next(e); }
});
router.get('/prescriptions/:id/file', async (req, res, next) => {
  try { const rx = await findRx(req, res); if (rx?.file?.id) sendFile(res, rx.file); else if (rx) res.status(404).json({ error: 'No file' }); } catch (e) { next(e); }
});
router.delete('/prescriptions/:id', requireRole('admin', 'doctor'), async (req, res, next) => {
  try { const rx = await findRx(req, res); if (rx) { await deleteFile(rx.file?.id); await rx.deleteOne(); res.json({ ok: true }); } } catch (e) { next(e); }
});

export default router;
