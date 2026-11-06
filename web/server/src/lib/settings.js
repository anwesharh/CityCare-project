// src/lib/settings.js — clinic settings (single document), with defaults
import { Settings } from '../models/index.js';

const wk = (open, close) => ({ open, close });
export const DEFAULT_SETTINGS = {
  clinicName: 'CityCare Clinic',
  tagline: 'Book, cancel or reschedule your visit — just by talking.',
  addressLines: ['12 Park Street, Kolkata', 'Near Park Street metro station'],
  mapEmbedUrl: '',
  payments: 'Cash, UPI and all major cards accepted.',
  languages: 'English · বাংলা · हिन्दी',
  greeting: 'Namaste, thank you for calling CityCare Clinic. How can I help you today?',
  afterHoursMessage: 'The clinic is closed right now. We are open Monday to Friday 10 AM to 8 PM, and Saturday 10 AM to 2 PM. Would you like to leave a message or book an appointment?',
  extraInstructions: '',
  hours: {
    monday: wk('10:00', '20:00'), tuesday: wk('10:00', '20:00'), wednesday: wk('10:00', '20:00'),
    thursday: wk('10:00', '20:00'), friday: wk('10:00', '20:00'), saturday: wk('10:00', '14:00'), sunday: null,
  },
  faqs: [
    { question: 'What are the consultation fees?', answer: 'A general consultation is 500 rupees. Follow-up visits within 7 days are free.' },
    { question: 'Where is the clinic?', answer: 'We are at 12 Park Street, Kolkata, near the Park Street metro station.' },
    { question: 'Do you accept UPI or cards?', answer: 'Yes, we accept cash, UPI and all major cards.' },
  ],
  doctors: [
    { name: 'Dr. Sen', specialty: 'General physician', fee: '₹500', days: 'Monday – Friday evenings', slotMinutes: 15,
      useOwnHours: true, leaveDates: [], active: true,
      hours: { monday: wk('17:00', '20:00'), tuesday: wk('17:00', '20:00'), wednesday: wk('17:00', '20:00'),
        thursday: wk('17:00', '20:00'), friday: wk('17:00', '20:00'), saturday: null, sunday: null } },
    { name: 'Dr. Das', specialty: 'Paediatrician', fee: '₹500', days: 'Saturdays', slotMinutes: 15,
      useOwnHours: true, leaveDates: [], active: true,
      hours: { monday: null, tuesday: null, wednesday: null, thursday: null, friday: null,
        saturday: wk('10:00', '14:00'), sunday: null } },
  ],
  // ---- hospital (all optional; empty = clinic mode) ----
  departments: [],
  emergency: { phone: '', ambulancePhone: '', note: '' },
  visitingHours: '',
  admissionInfo: '',
  insuranceInfo: '',
  beds: [],
  lab: { name: 'Diagnostic Lab', bookable: false, useOwnHours: false, hours: {}, slotMinutes: 10, collectInfo: '', tests: [], packages: [] },
};

/** Example hospital data staff can load with one click on the settings page. */
export const SAMPLE_HOSPITAL = {
  departments: [
    { name: 'General Medicine', description: 'Fever, infections, diabetes, BP', location: 'Ground floor' },
    { name: 'Paediatrics', description: 'Children and newborns', location: '1st floor' },
    { name: 'Orthopaedics', description: 'Bones, joints, fractures, back pain', location: '1st floor' },
    { name: 'Cardiology', description: 'Heart and chest problems', location: '2nd floor' },
    { name: 'Gynaecology', description: "Women's health and pregnancy", location: '2nd floor' },
    { name: 'Diagnostics', description: 'Lab tests, X-ray, ultrasound, ECG', location: 'Ground floor' },
  ],
  emergency: { phone: '033 4000 1111', ambulancePhone: '98300 00000', note: 'Emergency is open 24 hours, 7 days.' },
  visitingHours: '11 AM to 12 noon and 5 PM to 7 PM daily. One visitor per patient in wards; no visitors in ICU except at 6 PM.',
  admissionInfo: 'Planned admissions at the admission desk, ground floor, 9 AM to 6 PM. Bring a photo ID, the doctor\'s advice and insurance card.',
  insuranceInfo: 'Cashless available with Star Health, HDFC Ergo, ICICI Lombard, Niva Bupa and Ayushman Bharat (PM-JAY). Visit the TPA desk with your policy card and photo ID at least 2 days before a planned admission.',
  beds: [{ ward: 'General ward', total: 40, available: 6 }, { ward: 'Private room', total: 12, available: 2 }, { ward: 'ICU', total: 10, available: 1 }],
  lab: {
    name: 'Diagnostic Lab', bookable: true, useOwnHours: true, slotMinutes: 10,
    hours: { monday: wk('07:00', '19:00'), tuesday: wk('07:00', '19:00'), wednesday: wk('07:00', '19:00'),
      thursday: wk('07:00', '19:00'), friday: wk('07:00', '19:00'), saturday: wk('07:00', '14:00'), sunday: null },
    collectInfo: 'Collect reports at the lab counter, ground floor, 8 AM to 8 PM, with your bill.',
    tests: [
      { name: 'Complete blood count (CBC)', price: '₹300', prep: 'No preparation', reportTime: 'same evening' },
      { name: 'Fasting blood sugar', price: '₹150', prep: '10 to 12 hours fasting; water is fine', reportTime: 'same day' },
      { name: 'Lipid profile', price: '₹600', prep: '12 hours fasting', reportTime: 'same day' },
      { name: 'Thyroid profile (T3, T4, TSH)', price: '₹550', prep: 'No preparation', reportTime: 'next day' },
      { name: 'Chest X-ray', price: '₹450', prep: 'Remove metal items', reportTime: '2 hours' },
      { name: 'Ultrasound whole abdomen', price: '₹1200', prep: '6 hours fasting, full bladder', reportTime: 'same day' },
      { name: 'ECG', price: '₹250', prep: 'No preparation', reportTime: '15 minutes' },
    ],
    packages: [
      { name: 'Basic health check-up', price: '₹999', includes: 'CBC, blood sugar, urine routine, ECG', prep: '10 hours fasting' },
      { name: 'Full body check-up', price: '₹2499', includes: 'CBC, sugar, lipid, liver, kidney, thyroid, ECG, chest X-ray, doctor consultation', prep: '12 hours fasting' },
      { name: 'Senior citizen package', price: '₹3499', includes: 'Full body tests plus HbA1c, vitamin D, B12 and ultrasound abdomen', prep: '12 hours fasting' },
    ],
  },
};

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Validate + clean hours from the form: each day {open, close} or null. */
export function cleanHours(raw) {
  const out = {};
  for (const d of DAYS) {
    const v = raw?.[d];
    out[d] = v && TIME.test(v.open || '') && TIME.test(v.close || '') && v.open < v.close
      ? { open: v.open, close: v.close } : null;
  }
  return out;
}

export function cleanSettings(body = {}) {
  const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  return {
    clinicName: str(body.clinicName, 120) || DEFAULT_SETTINGS.clinicName,
    tagline: str(body.tagline, 200),
    addressLines: (Array.isArray(body.addressLines) ? body.addressLines : []).map((l) => str(l, 200)).filter(Boolean).slice(0, 4),
    mapEmbedUrl: /^https:\/\/(www\.)?google\.[a-z.]+\/maps\/embed/.test(str(body.mapEmbedUrl)) ? str(body.mapEmbedUrl) : '',
    payments: str(body.payments, 300),
    languages: str(body.languages, 120),
    greeting: str(body.greeting, 500),
    afterHoursMessage: str(body.afterHoursMessage, 800),
    extraInstructions: str(body.extraInstructions, 2000),
    hours: cleanHours(body.hours),
    faqs: (Array.isArray(body.faqs) ? body.faqs : [])
      .map((f) => ({ question: str(f?.question, 300), answer: str(f?.answer, 1000) }))
      .filter((f) => f.question && f.answer).slice(0, 60),
    doctors: (Array.isArray(body.doctors) ? body.doctors : []).map((d) => ({
      ...(d?._id ? { _id: d._id } : {}),
      name: str(d?.name, 80),
      specialty: str(d?.specialty, 80),
      fee: str(d?.fee, 40),
      days: str(d?.days, 120),
      slotMinutes: Math.min(240, Math.max(5, Number(d?.slotMinutes) || 15)),
      useOwnHours: Boolean(d?.useOwnHours),
      hours: cleanHours(d?.hours),
      leaveDates: (Array.isArray(d?.leaveDates) ? d.leaveDates : []).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).slice(0, 120),
      active: d?.active !== false,
      department: str(d?.department, 80),
      room: str(d?.room, 40),
      substitute: str(d?.substitute, 80),
    })).filter((d) => d.name).slice(0, 80),
    ...cleanHospital(body),
  };
}

const list = (v) => (Array.isArray(v) ? v : []);

/** Hospital fields. Bed counts are NOT here: they're updated separately (cleanBeds). */
export function cleanHospital(body = {}) {
  const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const test = (t) => ({ name: str(t?.name, 120), price: str(t?.price, 40), prep: str(t?.prep, 300),
    reportTime: str(t?.reportTime, 60), includes: str(t?.includes, 400) });
  const lab = body.lab || {};
  return {
    departments: list(body.departments).map((d) => ({ name: str(d?.name, 80), description: str(d?.description, 200),
      location: str(d?.location, 80) })).filter((d) => d.name).slice(0, 40),
    emergency: { phone: str(body.emergency?.phone, 40), ambulancePhone: str(body.emergency?.ambulancePhone, 40),
      note: str(body.emergency?.note, 300) },
    visitingHours: str(body.visitingHours, 500),
    admissionInfo: str(body.admissionInfo, 800),
    insuranceInfo: str(body.insuranceInfo, 1200),
    lab: {
      name: str(lab.name, 60) || 'Diagnostic Lab',
      bookable: Boolean(lab.bookable),
      useOwnHours: Boolean(lab.useOwnHours),
      hours: cleanHours(lab.hours),
      slotMinutes: Math.min(120, Math.max(5, Number(lab.slotMinutes) || 10)),
      collectInfo: str(lab.collectInfo, 300),
      tests: list(lab.tests).map(test).filter((t) => t.name).slice(0, 150),
      packages: list(lab.packages).map(test).filter((t) => t.name).slice(0, 40),
    },
  };
}

export function cleanBeds(beds) {
  const n = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? undefined : Math.max(0, Math.round(Number(v))));
  return list(beds).map((b) => ({ ward: String(b?.ward || '').trim().slice(0, 60), total: n(b?.total), available: n(b?.available) }))
    .filter((b) => b.ward).slice(0, 30);
}

export async function saveBeds(beds) {
  return Settings.findOneAndUpdate({ key: 'clinic' }, { $set: { beds: cleanBeds(beds), bedsUpdatedAt: new Date() } },
    { upsert: true, new: true, lean: true });
}

export async function getSettings() {
  let doc = await Settings.findOne({ key: 'clinic' }).lean();
  if (!doc) {
    doc = (await Settings.create({ key: 'clinic', ...DEFAULT_SETTINGS })).toObject();
  }
  return doc;
}

export async function saveSettings(body) {
  const clean = cleanSettings(body);
  return Settings.findOneAndUpdate({ key: 'clinic' }, { key: 'clinic', ...clean },
    { upsert: true, new: true, lean: true });
}

/** What the public website may show (no internal instructions). */
export function publicView(s) {
  return {
    clinicName: s.clinicName, tagline: s.tagline, addressLines: s.addressLines || [],
    mapEmbedUrl: s.mapEmbedUrl, payments: s.payments, languages: s.languages, hours: s.hours,
    doctors: (s.doctors || []).filter((d) => d.active).map((d) => ({
      name: d.name, specialty: d.specialty, fee: d.fee, days: d.days, department: d.department || '', room: d.room || '',
    })),
    departments: s.departments || [],
    emergency: s.emergency || {},
    visitingHours: s.visitingHours || '',
    insuranceInfo: s.insuranceInfo || '',
    lab: s.lab ? { name: s.lab.name, collectInfo: s.lab.collectInfo, tests: s.lab.tests || [], packages: s.lab.packages || [] } : null,
  };
}
