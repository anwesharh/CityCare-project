// src/lib/ics.js — medicine reminders as a calendar file (works with Google Calendar, iPhone, Outlook — free)
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/[,;]/g, (m) => `\\${m}`).replace(/\n/g, '\\n');

/** India has no daylight saving: IST = UTC+05:30, so a fixed shift is exact. */
function istToUtcStamp(ymd, hhmm) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, h, mi) - 330 * 60000);
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}00Z`;
}

/** One repeating event per medicine per time, each with a pop-up alarm. */
export function prescriptionToIcs(rx, { clinicName = 'Clinic', startDate } = {}) {
  const start = startDate || new Date().toISOString().slice(0, 10);
  const now = istToUtcStamp(new Date().toISOString().slice(0, 10), '00:00');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${esc(clinicName)}//Medicine reminders//EN`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const m of rx.medicines || []) {
    if (!m.reminders || !(m.times || []).length) continue;
    const count = m.durationDays || 30;
    const what = [m.dose, m.timing].filter(Boolean).join(', ');
    for (const t of m.times) {
      if (!/^\d{2}:\d{2}$/.test(t)) continue;
      lines.push(
        'BEGIN:VEVENT',
        `UID:${rx._id}-${m._id || m.name}-${t.replace(':', '')}@citycare`,
        `DTSTAMP:${now}`,
        `DTSTART:${istToUtcStamp(start, t)}`,
        'DURATION:PT10M',
        `RRULE:FREQ=DAILY;COUNT=${count}`,
        `SUMMARY:${esc(`Take ${m.name}${m.strength ? ` ${m.strength}` : ''}`)}`,
        `DESCRIPTION:${esc([what, m.instructions, rx.doctor && `Prescribed by ${rx.doctor}`].filter(Boolean).join('\n'))}`,
        'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(`Take ${m.name}`)}`, 'TRIGGER:PT0M', 'END:VALARM',
        'END:VEVENT',
      );
    }
  }
  lines.push('END:VCALENDAR');
  return lines.map((l) => (l.length > 74 ? l.match(/.{1,74}/g).join('\r\n ') : l)).join('\r\n') + '\r\n';
}
