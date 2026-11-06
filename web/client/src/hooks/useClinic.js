// src/hooks/useClinic.js — public clinic details from the server (falls back to src/clinic.js)
import { useEffect, useState } from 'react';
import { CLINIC } from '../clinic.js';

const DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const LABEL = { monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday' };

const to12 = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

/** Collapse a weekly schedule into rows like "Monday – Friday: 10:00 AM – 8:00 PM". */
export function hoursRows(hours) {
  if (!hours) return CLINIC.hours;
  const items = DAY_NAMES.map((d) => ({ d, t: hours[d]?.open && hours[d]?.close ? `${to12(hours[d].open)} – ${to12(hours[d].close)}` : 'Closed' }));
  const rows = [];
  for (const it of items) {
    const last = rows[rows.length - 1];
    if (last && last.time === it.t) last.to = it.d; else rows.push({ from: it.d, to: it.d, time: it.t });
  }
  return rows.map((r) => ({ days: r.from === r.to ? LABEL[r.from] : `${LABEL[r.from]} – ${LABEL[r.to]}`, time: r.time, closed: r.time === 'Closed' }));
}

const FALLBACK = {
  clinicName: CLINIC.name, tagline: '', addressLines: CLINIC.address, mapEmbedUrl: CLINIC.mapEmbedUrl,
  payments: CLINIC.payments, languages: CLINIC.languages, hours: null,
  doctors: CLINIC.doctors.map((d) => ({ name: d.name, specialty: d.role, days: d.when })),
};

let cache = null;
export function useClinic() {
  const [clinic, setClinic] = useState(cache || FALLBACK);
  useEffect(() => {
    if (cache) return;
    fetch('/api/clinic').then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (d?.clinic) { cache = { ...FALLBACK, ...d.clinic }; setClinic(cache); }
    }).catch(() => {});
  }, []);
  return clinic;
}
