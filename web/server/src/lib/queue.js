// src/lib/queue.js — OPD queue: "now serving" token per doctor for today
import { QueueState } from '../models/index.js';
import { getSettings } from './settings.js';
import { calendarConfigured, listAppointments, sameDoctor } from './calendar.js';
import { dayRange } from '../routes/admin.js';

let cache = { at: 0, ymd: '', appts: null };

/** Today's appointments, cached for 60 s so a waiting-room TV can poll often. */
async function todaysAppointments(start, end, ymd) {
  if (!calendarConfigured()) return null;
  if (cache.ymd === ymd && Date.now() - cache.at < 60000) return cache.appts;
  try {
    const appts = await listAppointments({ from: start, to: end });
    cache = { at: Date.now(), ymd, appts };
    return appts;
  } catch (e) {
    console.error('[queue] calendar error:', e.message);
    return cache.ymd === ymd ? cache.appts : null;
  }
}

export function clearQueueCache() { cache = { at: 0, ymd: '', appts: null }; }

/** Build the queue view from doctors, saved queue state and today's appointments. */
export function buildQueue(doctors, states, appts, ymd = '') {
  return doctors.map((d) => {
    const st = states.find((q) => sameDoctor(q.doctor, d.name));
    const nowServing = st?.nowServing || 0;
    const mine = appts ? appts.filter((a) => sameDoctor(a.doctor, d.name) && a.token) : null;
    const lastToken = mine ? mine.reduce((m, a) => Math.max(m, a.token), 0) : null;
    return {
      doctor: d.name, specialty: d.specialty || '', department: d.department || '', room: d.room || '',
      nowServing,
      waiting: mine ? mine.filter((a) => a.token > nowServing).length : null,
      lastToken,
      onLeave: Boolean(ymd && (d.leaveDates || []).includes(ymd)),
    };
  });
}

export async function getQueue() {
  const { start, end, ymd } = dayRange();
  const settings = await getSettings();
  const lab = settings.lab?.bookable ? [{ name: settings.lab.name || 'Diagnostic Lab', department: 'Diagnostics' }] : [];
  const doctors = [...(settings.doctors || []).filter((d) => d.active !== false), ...lab];
  const [states, appts] = await Promise.all([QueueState.find({ date: ymd }).lean(), todaysAppointments(start, end, ymd)]);
  const items = buildQueue(doctors, states, appts, ymd);
  return { date: ymd, clinicName: settings.clinicName, items };
}

export async function moveQueue(doctor, action, value) {
  const { ymd } = dayRange();
  const st = await QueueState.findOne({ date: ymd, doctor }) || new QueueState({ date: ymd, doctor, nowServing: 0 });
  if (action === 'next') st.nowServing += 1;
  else if (action === 'prev') st.nowServing = Math.max(0, st.nowServing - 1);
  else if (action === 'set') st.nowServing = Math.max(0, Math.min(999, Math.round(Number(value) || 0)));
  else if (action === 'reset') st.nowServing = 0;
  await st.save();
  return st.nowServing;
}
