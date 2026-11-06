// src/lib/calendar.js — Google Calendar access using the agent's OAuth token
// The agent's setup command (python -m receptionist.booking setup myclinic)
// already saved a refresh token in secrets/myclinic/google-calendar-oauth.json.
// We reuse it, so staff and the AI see the same calendar.
import fs from 'node:fs';
import { google } from 'googleapis';
import { config } from '../config.js';

let cachedCalendar = null;

export function calendarConfigured() {
  return Boolean(config.calendar.tokenFile && fs.existsSync(config.calendar.tokenFile));
}

function getCalendar() {
  if (cachedCalendar) return cachedCalendar;
  if (!calendarConfigured()) {
    const err = new Error('Google Calendar not connected: set GOOGLE_OAUTH_TOKEN_FILE in server/.env');
    err.status = 503;
    throw err;
  }
  const saved = JSON.parse(fs.readFileSync(config.calendar.tokenFile, 'utf8'));
  const auth = new google.auth.OAuth2(saved.client_id, saved.client_secret);
  auth.setCredentials({ refresh_token: saved.refresh_token });
  cachedCalendar = google.calendar({ version: 'v3', auth });
  return cachedCalendar;
}

const AI_TAG = '[via AI receptionist';

/** Turn a Google event into the shape the dashboard uses. */
export function toAppointment(ev) {
  const desc = ev.description || '';
  const line = (label) => {
    const m = desc.match(new RegExp(`^${label}:\\s*(.*)$`, 'm'));
    const v = m ? m[1].trim() : '';
    return v && v !== '(none)' ? v : null;
  };
  const ai = desc.includes(AI_TAG);
  const summary = ev.summary || '';
  const name = line('Caller') || summary.replace(/^Appointment:\s*/i, '') || 'Unknown';
  const rescheduled = /^Rescheduled:/m.test(desc);
  const token = Number(line('Token')) || null;
  return {
    id: ev.id,
    start: ev.start?.dateTime || ev.start?.date,
    end: ev.end?.dateTime || ev.end?.date,
    allDay: !ev.start?.dateTime,
    patientName: name.replace(/\s*\((Dr\.?[^)]*)\)\s*$/i, ''),
    doctor: line('Doctor'),
    token,
    phone: line('Callback'),
    email: line('Email'),
    notes: line('Notes'),
    bookedVia: ai ? 'AI receptionist' : 'Front desk',
    status: rescheduled ? 'rescheduled' : 'confirmed',
    callId: line('Call ID'),
    link: ev.htmlLink,
  };
}

const normDoctor = (n) => String(n || '').replace(/^(dr\.?|doctor)\s+/i, '').trim().toLowerCase();
export const sameDoctor = (a, b) => normDoctor(a) === normDoctor(b);

export async function listAppointments({ from, to, q, doctor } = {}) {
  const cal = getCalendar();
  const res = await cal.events.list({
    calendarId: config.calendar.calendarId,
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 500,
  });
  let items = (res.data.items || [])
    .filter((ev) => ev.status !== 'cancelled' && ev.start?.dateTime)
    .map(toAppointment);
  if (doctor) items = items.filter((a) => sameDoctor(a.doctor, doctor));
  if (q) {
    const needle = q.toLowerCase();
    const digits = q.replace(/\D/g, '');
    items = items.filter((a) => a.patientName.toLowerCase().includes(needle)
      || (digits.length >= 3 && (a.phone || '').replace(/\D/g, '').includes(digits)));
  }
  return items;
}

export async function cancelAppointment(id) {
  await getCalendar().events.delete({ calendarId: config.calendar.calendarId, eventId: id, sendUpdates: 'all' });
}

/** Move an event to newStart, keeping its length. Refuses if something else is there. */
export async function rescheduleAppointment(id, newStart, staffName) {
  const cal = getCalendar();
  const { data: ev } = await cal.events.get({ calendarId: config.calendar.calendarId, eventId: id });
  const oldStart = new Date(ev.start.dateTime);
  const oldEnd = new Date(ev.end.dateTime);
  const start = new Date(newStart);
  if (Number.isNaN(start.getTime())) {
    const err = new Error('Invalid new time'); err.status = 400; throw err;
  }
  const end = new Date(start.getTime() + (oldEnd - oldStart));

  const fb = await cal.freebusy.query({ requestBody: {
    timeMin: start.toISOString(), timeMax: end.toISOString(),
    items: [{ id: config.calendar.calendarId }],
  } });
  const doctor = toAppointment(ev).doctor;
  let clash;
  if (doctor) {
    // One shared calendar: only this doctor's bookings (and untagged events) block the slot.
    const { data } = await cal.events.list({ calendarId: config.calendar.calendarId, timeMin: start.toISOString(),
      timeMax: end.toISOString(), singleEvents: true, maxResults: 50 });
    clash = (data.items || []).some((other) => other.id !== id && other.status !== 'cancelled'
      && other.start?.dateTime && (!toAppointment(other).doctor || sameDoctor(toAppointment(other).doctor, doctor)));
  } else {
    clash = (fb.data.calendars?.[config.calendar.calendarId]?.busy || [])
      .some((b) => !(new Date(b.start) >= oldStart && new Date(b.end) <= oldEnd));
  }
  if (clash) { const err = new Error('That time is already booked'); err.status = 409; throw err; }

  const note = `Rescheduled: ${new Date().toISOString()} (by ${staffName || 'staff'} via dashboard)`;
  const { data } = await cal.events.patch({
    calendarId: config.calendar.calendarId, eventId: id, sendUpdates: 'all',
    requestBody: {
      start: { dateTime: start.toISOString(), timeZone: config.calendar.timezone },
      end: { dateTime: end.toISOString(), timeZone: config.calendar.timezone },
      description: `${(ev.description || '').trimEnd()}\n${note}`.trim(),
    },
  });
  return toAppointment(data);
}
