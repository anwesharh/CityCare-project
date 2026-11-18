// src/lib/prescriptions.js — save an uploaded prescription, read it in the background, clean edits
import { Prescription } from '../models/index.js';
import { readFile, saveFile } from './files.js';
import { readPrescription } from './ocr.js';
import { runInBackground } from './background.js';

const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); // IST date

/** Store the file, create the record, then read it with Gemini without making the user wait. */
export async function createPrescription(file, { phoneKey, patientName, source, uploadedBy }) {
  const stored = await saveFile(file, { kind: 'prescription', phoneKey });
  const rx = await Prescription.create({ phoneKey, patientName, source, uploadedBy, file: stored, date: today(), status: 'reading' });
  runInBackground(processPrescription(rx._id, file.buffer, file.mimetype), 'prescription');
  return rx;
}

export async function processPrescription(id, buffer, contentType) {
  try {
    const r = await readPrescription(buffer, contentType);
    if (r.notPrescription || (!r.medicines.length && !r.text)) {
      await Prescription.updateOne({ _id: id }, { status: 'failed', error: "This doesn't look like a prescription, or it couldn't be read. You can add the medicines by hand." });
      return;
    }
    const $set = { status: 'done', error: '', text: r.text, medicines: r.medicines, advice: r.advice };
    if (r.doctor) $set.doctor = r.doctor;
    if (r.date) $set.date = r.date;
    if (r.patientName) $set.writtenName = r.patientName;
    await Prescription.updateOne({ _id: id }, { $set });
  } catch (e) {
    console.error('[prescription] read failed:', e.message);
    await Prescription.updateOne({ _id: id }, { status: 'failed', error: 'Could not read it automatically. Try a clearer photo, or add the medicines by hand.' });
  }
}

/** Re-run the reader on an existing prescription (e.g. after a failure). */
export async function retryPrescription(rx) {
  rx.status = 'reading'; rx.error = '';
  await rx.save();
  const buf = await readFile(rx.file.id);
  runInBackground(processPrescription(rx._id, buf, rx.file.contentType), 'prescription');
  return rx;
}

/** Apply edits from the patient/staff (medicine list, reminder times, doctor, date). */
export function applyEdits(rx, body = {}) {
  const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  if (body.doctor !== undefined) rx.doctor = str(body.doctor, 120);
  if (body.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) rx.date = body.date;
  if (body.advice !== undefined) rx.advice = str(body.advice, 1000);
  if (Array.isArray(body.medicines)) {
    rx.medicines = body.medicines.slice(0, 30).map((m) => {
      const days = Number(m?.durationDays);
      const times = (Array.isArray(m?.times) ? m.times : []).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)).slice(0, 6);
      return {
        name: str(m?.name, 120), strength: str(m?.strength, 60), form: str(m?.form, 40), dose: str(m?.dose, 80),
        frequencyText: str(m?.frequencyText, 60), timing: str(m?.timing, 40),
        durationDays: Number.isFinite(days) && days > 0 ? Math.min(365, Math.round(days)) : null,
        instructions: str(m?.instructions, 300), category: str(m?.category, 60),
        verified: m?.verified !== false, times: [...new Set(times)].sort(), reminders: Boolean(m?.reminders) && times.length > 0,
      };
    }).filter((m) => m.name);
    if (rx.status === 'failed' && rx.medicines.length) { rx.status = 'done'; rx.error = ''; }
  }
  return rx;
}

/** What the browser gets (no internal fields). */
export const publicRx = (rx) => {
  const o = rx.toObject ? rx.toObject() : rx;
  return { _id: o._id, doctor: o.doctor, date: o.date, advice: o.advice, text: o.text, medicines: o.medicines,
    status: o.status, error: o.error, source: o.source, patientName: o.patientName, createdAt: o.createdAt,
    file: o.file ? { name: o.file.name, contentType: o.file.contentType, size: o.file.size } : null };
};
