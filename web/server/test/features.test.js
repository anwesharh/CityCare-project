// Tests for settings, roles, patients grouping and calendar doctor/token parsing (no database).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LIVEKIT_URL ||= 'wss://example.livekit.cloud';
process.env.LIVEKIT_API_KEY ||= 'APIkey123';
process.env.LIVEKIT_API_SECRET ||= 'secret-secret-secret-secret-secret-123';
process.env.DASHBOARD_WEBHOOK_SECRET ||= 'hook-secret';
process.env.JWT_SECRET ||= 'jwt-secret';

const { cleanSettings, publicView, cleanHours, DEFAULT_SETTINGS } = await import('../src/lib/settings.js');
const { toAppointment, sameDoctor } = await import('../src/lib/calendar.js');
const { appointmentsByPhone } = await import('../src/routes/insights.js');
const { signToken } = await import('../src/lib/auth.js');
const { phoneKey } = await import('../src/models/index.js');
const { createApp } = await import('../src/app.js');

test('hours: invalid or reversed times become closed days', () => {
  const h = cleanHours({ monday: { open: '10:00', close: '20:00' }, tuesday: { open: '20:00', close: '10:00' }, wednesday: { open: '25:00', close: '26:00' } });
  assert.deepEqual(h.monday, { open: '10:00', close: '20:00' });
  assert.equal(h.tuesday, null);
  assert.equal(h.wednesday, null);
  assert.equal(h.sunday, null);
});

test('settings are cleaned: empty FAQs/doctors dropped, map URL must be Google embed', () => {
  const s = cleanSettings({
    clinicName: '  CityCare  ', faqs: [{ question: 'Fees?', answer: '500' }, { question: '', answer: 'x' }],
    doctors: [{ name: 'Dr. Sen', slotMinutes: 1000, leaveDates: ['2026-11-02', 'nope'] }, { name: '' }],
    mapEmbedUrl: 'https://evil.example.com/x',
  });
  assert.equal(s.clinicName, 'CityCare');
  assert.equal(s.faqs.length, 1);
  assert.equal(s.doctors.length, 1);
  assert.equal(s.doctors[0].slotMinutes, 240);
  assert.deepEqual(s.doctors[0].leaveDates, ['2026-11-02']);
  assert.equal(s.mapEmbedUrl, '');
});

test('public view hides internal instructions and inactive doctors', () => {
  const v = publicView({ ...DEFAULT_SETTINGS, extraInstructions: 'secret', doctors: [{ name: 'A', active: true }, { name: 'B', active: false }] });
  assert.equal(v.extraInstructions, undefined);
  assert.deepEqual(v.doctors.map((d) => d.name), ['A']);
});

test('calendar parsing reads doctor and token', () => {
  const a = toAppointment({ id: 'e', summary: 'Appointment: Asha (Dr. Sen)',
    start: { dateTime: '2026-11-02T17:00:00+05:30' }, end: { dateTime: '2026-11-02T17:15:00+05:30' },
    description: '[via AI receptionist / UNVERIFIED]\nCaller: Asha\nCallback: 98300 12345\nDoctor: Dr. Sen\nToken: 3' });
  assert.equal(a.doctor, 'Dr. Sen');
  assert.equal(a.token, 3);
  assert.equal(a.patientName, 'Asha');
  assert.ok(sameDoctor('Dr. Sen', 'sen'));
});

test('patients group appointments by last 10 digits', () => {
  const map = appointmentsByPhone([{ phone: '+91 98300 12345' }, { phone: '9830012345' }, { phone: '12' }]);
  assert.equal(map.get(phoneKey('09830012345')).length, 2);
  assert.equal(map.size, 1);
});

test('HTTP: roles and agent settings are protected', async () => {
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const staff = signToken({ _id: 'u1', email: 's@x.in', role: 'staff', name: 'S' });
  const doctor = signToken({ _id: 'u2', email: 'd@x.in', role: 'doctor', name: 'D', doctorName: 'Dr. Sen' });
  const auth = (t) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });
  try {
    assert.equal((await fetch(`${base}/api/agent/settings`)).status, 401);
    assert.equal((await fetch(`${base}/api/admin/users`, { headers: auth(staff) })).status, 403);
    assert.equal((await fetch(`${base}/api/admin/settings`, { method: 'PUT', headers: auth(staff), body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}/api/admin/analytics`, { headers: auth(doctor) })).status, 403);
    assert.equal((await fetch(`${base}/api/admin/live`, { headers: auth(doctor) })).status, 403);
  } finally { server.close(); }
});

// ---------------- hospital features ----------------
const { cleanHospital, cleanBeds, SAMPLE_HOSPITAL } = await import('../src/lib/settings.js');
const { buildQueue } = await import('../src/lib/queue.js');

test('hospital settings are cleaned; beds are not part of the main settings save', () => {
  const s = cleanSettings({
    doctors: [{ name: 'Dr. Bose', department: 'Orthopaedics', room: '4', substitute: 'Dr. Roy' }],
    departments: [{ name: 'Cardiology', location: '2nd floor' }, { name: '' }],
    emergency: { phone: ' 033 4000 1111 ' }, beds: [{ ward: 'ICU', available: 1 }],
    lab: { bookable: 1, slotMinutes: 1, tests: [{ name: 'CBC', price: '₹300' }, { name: '' }] },
  });
  assert.equal(s.doctors[0].department, 'Orthopaedics');
  assert.equal(s.doctors[0].substitute, 'Dr. Roy');
  assert.deepEqual(s.departments.map((d) => d.name), ['Cardiology']);
  assert.equal(s.emergency.phone, '033 4000 1111');
  assert.equal(s.lab.bookable, true);
  assert.equal(s.lab.slotMinutes, 5);
  assert.equal(s.lab.tests.length, 1);
  assert.equal('beds' in s, false);
});

test('bed counts: blanks allowed, negatives clamped, empty wards dropped', () => {
  assert.deepEqual(cleanBeds([{ ward: 'ICU', total: '10', available: -2 }, { ward: 'General', available: '' }, { ward: ' ' }]),
    [{ ward: 'ICU', total: 10, available: 0 }, { ward: 'General', total: undefined, available: undefined }]);
});

test('sample hospital data survives cleaning', () => {
  const s = cleanHospital(SAMPLE_HOSPITAL);
  assert.ok(s.departments.length >= 5 && s.lab.tests.length >= 5 && s.lab.packages.length >= 3);
  assert.equal(s.lab.hours.sunday, null);
});

test('queue: waiting = booked tokens after the one being served, per doctor', () => {
  const appts = [{ doctor: 'Dr. Sen', token: 1 }, { doctor: 'Dr. Sen', token: 2 }, { doctor: 'Dr. Sen', token: 3 },
    { doctor: 'Dr. Das', token: 1 }];
  const q = buildQueue([{ name: 'Dr. Sen', leaveDates: ['2026-10-29'] }, { name: 'Dr. Das' }],
    [{ doctor: 'Dr. Sen', nowServing: 1 }], appts, '2026-10-29');
  assert.deepEqual(q.map((i) => [i.doctor, i.nowServing, i.waiting, i.lastToken, i.onLeave]),
    [['Dr. Sen', 1, 2, 3, true], ['Dr. Das', 0, 1, 1, false]]);
  assert.equal(buildQueue([{ name: 'Dr. Sen' }], [], null)[0].waiting, null);
});

test('hospital routes need login; report-status needs the agent secret', async () => {
  const app = createApp();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    for (const p of ['/admin/reports', '/admin/queue', '/admin/alerts', '/admin/beds']) {
      assert.equal((await fetch(base + p)).status, 401, p);
    }
    const r = await fetch(`${base}/agent/report-status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
    const lab = signToken({ _id: 'u1', email: 'lab@x.in', role: 'lab', name: 'Lab' });
    const beds = await fetch(`${base}/admin/beds`, { method: 'PUT', headers: { authorization: `Bearer ${lab}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(beds.status, 403); // lab role can't change bed counts
  } finally { server.close(); }
});

test('lab role cannot open calls, messages or patients', async () => {
  const app = createApp();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/admin`;
  const lab = signToken({ _id: 'u1', email: 'lab@x.in', role: 'lab', name: 'Lab' });
  try {
    for (const p of ['/calls', '/messages', '/patients']) {
      assert.equal((await fetch(base + p, { headers: { authorization: `Bearer ${lab}` } })).status, 403, p);
    }
  } finally { server.close(); }
});
