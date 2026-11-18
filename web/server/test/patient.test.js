// Patient portal: prescription reading, reminders, login separation
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const { normalisePrescription, nameFoundInText, medicineCategory, parseJson } = await import('../src/lib/ocr.js');
const { prescriptionToIcs } = await import('../src/lib/ics.js');
const { applyEdits } = await import('../src/lib/prescriptions.js');
const { signPatientToken, hashCode, sameHash, newCode } = await import('../src/lib/patientAuth.js');
const { signToken } = await import('../src/lib/auth.js');
const { maskEmail } = await import('../src/lib/mailer.js');
const { createApp } = await import('../src/app.js');

test('prescription JSON is cleaned: times from morning/night, categories, verified against the read text', () => {
  const r = normalisePrescription({
    doctor: 'Dr. A. Sen', date: '2026-11-10', text: 'Tab Azithromycin 500mg 1-0-0 x 3 days\nTab Dolo 650 1-0-1 SOS',
    medicines: [
      { name: 'Azithromycin', strength: '500 mg', morning: true, frequency_text: '1-0-0', duration_days: 3, timing: 'after food' },
      { name: 'Dolo 650', morning: true, night: true, frequency_text: '1-0-1' },
      { name: 'Amoxicillin', morning: true }, // not in the text -> flagged
      { name: '' },
    ],
  });
  assert.equal(r.medicines.length, 3);
  assert.deepEqual(r.medicines[0].times, ['08:00']);
  assert.equal(r.medicines[0].durationDays, 3);
  assert.equal(r.medicines[0].category, 'Antibiotic');
  assert.deepEqual(r.medicines[1].times, ['08:00', '21:00']);
  assert.equal(r.medicines[1].category, 'Fever / pain relief');
  assert.equal(r.medicines[2].verified, false);
  assert.equal(r.medicines[0].verified, true);
});

test('Gemini answer with markdown fences still parses', () => {
  assert.deepEqual(parseJson('```json\n{"medicines":[]}\n```'), { medicines: [] });
});

test('drug classes from name patterns (CalmSpace rules)', () => {
  assert.equal(medicineCategory('Atorvastatin 10'), 'Cholesterol (statin)');
  assert.equal(medicineCategory('Pantoprazole'), 'Antacid (PPI)');
  assert.equal(medicineCategory('Telmisartan'), 'ARB (BP)');
  assert.equal(medicineCategory('Xyz'), '');
  assert.equal(nameFoundInText('Dolo 650', 'tab DOLO 650 bd'), true);
});

test('edits: bad times dropped, reminders off without times, empty names removed', () => {
  const rx = { medicines: [], status: 'failed' };
  applyEdits(rx, { medicines: [{ name: 'Dolo', times: ['21:00', '25:00', '08:00', '08:00'], reminders: true, durationDays: '5' },
    { name: 'ORS', times: [], reminders: true }, { name: ' ' }] });
  assert.deepEqual(rx.medicines.map((m) => [m.name, m.times, m.reminders, m.durationDays]),
    [['Dolo', ['08:00', '21:00'], true, 5], ['ORS', [], false, null]]);
  assert.equal(rx.status, 'done');
});

test('reminder calendar: IST times converted to UTC, daily repeat for the course length, with alarm', () => {
  const ics = prescriptionToIcs({ _id: 'rx1', doctor: 'Dr. Sen', medicines: [
    { _id: 'm1', name: 'Dolo', strength: '650 mg', dose: '1 tablet', times: ['08:00', '21:00'], reminders: true, durationDays: 5 },
    { _id: 'm2', name: 'ORS', times: ['10:00'], reminders: false },
  ] }, { clinicName: 'CityCare', startDate: '2026-11-15' });
  assert.match(ics, /DTSTART:20261115T023000Z/); // 08:00 IST
  assert.match(ics, /DTSTART:20261115T153000Z/); // 21:00 IST
  assert.match(ics, /RRULE:FREQ=DAILY;COUNT=5/);
  assert.match(ics, /BEGIN:VALARM/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2); // ORS reminders are off
});

test('login codes: 6 digits, hashed per phone, compared safely', () => {
  const c = newCode();
  assert.match(c, /^\d{6}$/);
  const h = hashCode('9830012345', c);
  assert.ok(sameHash(h, hashCode('9830012345', c)));
  assert.ok(!sameHash(h, hashCode('9830099999', c)));
  assert.ok(!sameHash(h, ''));
  assert.equal(maskEmail('anita.ghosh@gmail.com'), 'an*********@gmail.com');
});

test('patient and staff sessions cannot be swapped', async () => {
  const app = createApp();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const patient = signPatientToken('9830012345');
  const staff = signToken({ _id: 'u1', email: 'a@x.in', role: 'admin', name: 'A' });
  try {
    assert.equal((await fetch(`${base}/admin/reports`, { headers: { authorization: `Bearer ${patient}` } })).status, 401);
    assert.equal((await fetch(`${base}/patient/me`, { headers: { authorization: `Bearer ${staff}` } })).status, 401);
    assert.equal((await fetch(`${base}/patient/me`)).status, 401);
    const r = await fetch(`${base}/patient/request-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"phone":"123"}' });
    assert.equal(r.status, 400);
  } finally { server.close(); }
});

test('first-time patients are asked for an email; bad emails are refused', async () => {
  const { Patient } = await import('../src/models/index.js');
  const orig = Patient.findOne;
  Patient.findOne = async () => null; // no such patient yet (no database in tests)
  const app = createApp();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/patient`;
  const post = (body) => fetch(`${base}/request-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.deepEqual(await (await post({ phone: '9547204916' })).json(), { needsEmail: true });
    assert.equal((await post({ phone: '9547204916', email: 'not-an-email' })).status, 400);
  } finally { server.close(); Patient.findOne = orig; }
});
