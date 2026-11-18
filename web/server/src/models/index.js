// src/models/index.js — MongoDB collections
import mongoose from 'mongoose';

/** Last 10 digits of a phone number, used to match the same patient across calls/bookings. */
export const phoneKey = (v) => String(v || '').replace(/\D/g, '').slice(-10);

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, default: 'Staff' },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['admin', 'staff', 'doctor', 'lab'], default: 'staff' },
  doctorName: String, // for role "doctor": which doctor's appointments they see
  active: { type: Boolean, default: true },
}, { timestamps: true });

const transcriptLineSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant', 'tool'] },
  text: String,
  at: Date,
  toolOutput: String,
}, { _id: false });

const callSchema = new mongoose.Schema({
  callId: { type: String, required: true, unique: true },
  channel: { type: String, enum: ['web', 'phone'], default: 'web' },
  callerPhone: String,
  callerPhoneKey: { type: String, index: true },
  callerName: String,
  startedAt: Date,
  endedAt: Date,
  durationSeconds: Number,
  outcomes: [String],
  appointment: mongoose.Schema.Types.Mixed,
  faqsAnswered: [String],
  languages: [String],
  endReason: String,
  urgent: { type: Boolean, default: false, index: true },
  urgentKeywords: [String],
  emergencyReports: [mongoose.Schema.Types.Mixed],
  followedUp: { type: Boolean, default: false },
  summary: String,
  transcript: [transcriptLineSchema],
}, { timestamps: true });
callSchema.index({ startedAt: -1 });

const messageSchema = new mongoose.Schema({
  callId: { type: String, index: true },
  callerName: String,
  callbackNumber: String,
  callbackKey: { type: String, index: true },
  text: String,
  status: { type: String, enum: ['open', 'done'], default: 'open', index: true },
  receivedAt: { type: Date, default: Date.now },
}, { timestamps: true });

const patientSchema = new mongoose.Schema({
  phoneKey: { type: String, required: true, unique: true },
  phone: String,
  name: String,
  email: String,
  notes: { type: String, default: '' },
  lastSeenAt: Date,
  // patient-portal login code (hashed, short-lived)
  otpHash: String,
  otpExpires: Date,
  otpTries: { type: Number, default: 0 },
  otpSentAt: Date,
  otpEmail: String,            // email a sign-up code was sent to (saved once verified)
  portalLastLogin: Date,
}, { timestamps: true });

const dayHours = { open: String, close: String };
const hoursSchema = {
  monday: dayHours, tuesday: dayHours, wednesday: dayHours, thursday: dayHours,
  friday: dayHours, saturday: dayHours, sunday: dayHours,
};
const doctorSchema = new mongoose.Schema({
  name: { type: String, required: true },
  specialty: String,
  fee: String,
  days: String,            // short text for the website, e.g. "Weekday evenings"
  slotMinutes: Number,
  useOwnHours: { type: Boolean, default: false },
  hours: hoursSchema,
  leaveDates: [String],     // YYYY-MM-DD
  active: { type: Boolean, default: true },
  department: String,
  room: String,
  substitute: String,       // doctor who covers on leave days
}, { _id: true });

const testSchema = { name: String, price: String, prep: String, reportTime: String, includes: String };

const settingsSchema = new mongoose.Schema({
  key: { type: String, default: 'clinic', unique: true },
  clinicName: String,
  tagline: String,
  addressLines: [String],
  mapEmbedUrl: String,
  payments: String,
  languages: String,
  greeting: String,
  afterHoursMessage: String,
  extraInstructions: String,
  hours: hoursSchema,
  faqs: [{ question: String, answer: String }],
  doctors: [doctorSchema],
  // ---- hospital ----
  departments: [{ name: String, description: String, location: String }],
  emergency: { phone: String, ambulancePhone: String, note: String },
  visitingHours: String,
  admissionInfo: String,
  insuranceInfo: String,
  beds: [{ ward: String, total: Number, available: Number }],
  bedsUpdatedAt: Date,
  lab: {
    name: String, bookable: Boolean, useOwnHours: Boolean, hours: hoursSchema, slotMinutes: Number,
    collectInfo: String, tests: [testSchema], packages: [testSchema],
  },
}, { timestamps: true, minimize: false });

/** Lab / radiology report, so the receptionist can answer "is my report ready?". */
const reportSchema = new mongoose.Schema({
  reportNo: { type: String, index: true },
  patientName: String,
  phone: String,
  phoneKey: { type: String, index: true },
  test: String,
  status: { type: String, enum: ['processing', 'ready', 'collected'], default: 'processing', index: true },
  expectedOn: String,       // YYYY-MM-DD
  readyAt: Date,
  collectedAt: Date,
  notes: String,
  updatedBy: String,
  file: { id: mongoose.Schema.Types.ObjectId, name: String, contentType: String, size: Number, uploadedAt: Date },
}, { timestamps: true });
reportSchema.index({ createdAt: -1 });

/** A saved prescription: the original photo/PDF plus the medicines read from it. */
const medicineSchema = new mongoose.Schema({
  name: String,
  strength: String,
  form: String,
  dose: String,
  frequencyText: String,       // as written: 1-0-1, BD, TDS...
  timing: String,              // before food / after food
  durationDays: Number,
  instructions: String,
  category: String,            // e.g. "Antibiotic" (from the name pattern)
  verified: { type: Boolean, default: true }, // name actually found in the read text
  times: [String],             // reminder times, HH:MM
  reminders: { type: Boolean, default: true },
}, { _id: true });

const prescriptionSchema = new mongoose.Schema({
  phoneKey: { type: String, required: true, index: true },
  patientName: String,
  doctor: String,
  date: String,                // YYYY-MM-DD written on the prescription (or upload day)
  advice: String,
  writtenName: String,         // patient name as written on the prescription
  text: String,                // all text read from the image
  medicines: [medicineSchema],
  status: { type: String, enum: ['reading', 'done', 'failed'], default: 'reading' },
  error: String,
  source: { type: String, enum: ['patient', 'staff'], default: 'patient' },
  uploadedBy: String,
  file: { id: mongoose.Schema.Types.ObjectId, name: String, contentType: String, size: Number },
}, { timestamps: true });
prescriptionSchema.index({ phoneKey: 1, createdAt: -1 });

/** Live emergency alert sent by the agent during a call. */
const alertSchema = new mongoose.Schema({
  callId: { type: String, required: true, unique: true },
  keywords: [String],
  symptoms: String,
  callerName: String,
  callerPhone: String,
  at: Date,
  acknowledgedBy: String,
  acknowledgedAt: Date,
}, { timestamps: true });
alertSchema.index({ at: -1 });

/** OPD queue: which token each doctor is seeing now, per day. */
const queueSchema = new mongoose.Schema({
  date: { type: String, required: true },   // YYYY-MM-DD clinic time
  doctor: { type: String, required: true },
  nowServing: { type: Number, default: 0 },
}, { timestamps: true });
queueSchema.index({ date: 1, doctor: 1 }, { unique: true });

export const User = mongoose.model('User', userSchema);
export const Call = mongoose.model('Call', callSchema);
export const Message = mongoose.model('Message', messageSchema);
export const Patient = mongoose.model('Patient', patientSchema);
export const Settings = mongoose.model('Settings', settingsSchema);
export const Report = mongoose.model('Report', reportSchema);
export const Alert = mongoose.model('Alert', alertSchema);
export const QueueState = mongoose.model('QueueState', queueSchema);
export const Prescription = mongoose.model('Prescription', prescriptionSchema);
