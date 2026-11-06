// Run with: npm test   (no database needed)
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LIVEKIT_URL = 'wss://example.livekit.cloud';
process.env.LIVEKIT_API_KEY = 'APIkey123';
process.env.LIVEKIT_API_SECRET = 'secret-secret-secret-secret-secret-123';
process.env.DASHBOARD_WEBHOOK_SECRET = 'hook-secret';
process.env.JWT_SECRET = 'jwt-secret';
process.env.GOOGLE_OAUTH_TOKEN_FILE = '/nonexistent.json';

const { createVisitorToken } = await import('../src/routes/public.js');
const { toCallDoc } = await import('../src/routes/webhooks.js');
const { toAppointment } = await import('../src/lib/calendar.js');
const { dayRange } = await import('../src/routes/admin.js');
const { buildSummaryPrompt } = await import('../src/lib/summary.js');
const { createApp } = await import('../src/app.js');

const decode = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

test('visitor token grants join to a fresh room, no named dispatch by default', async () => {
  const t = await createVisitorToken({ displayName: 'Asha' });
  const claims = decode(t.token);
  assert.equal(t.url, 'wss://example.livekit.cloud');
  assert.match(t.room, /^web-/);
  assert.equal(claims.video.room, t.room);
  assert.equal(claims.video.roomJoin, true);
  assert.equal(claims.name, 'Asha');
  assert.equal(claims.roomConfig, undefined);
});

test('maps agent payload to a Call document', () => {
  const doc = toCallDoc({
    call_id: 'web-1', start_ts: '2026-10-28T05:00:00+00:00', end_ts: '2026-10-28T05:02:00+00:00',
    duration_seconds: 120, outcomes: ['appointment_booked'], urgent: true, urgent_keywords: ['chest pain'],
    emergency_reports: [{ symptoms: 'chest pain', callback_number: '9830012345', caller_name: 'Ritu' }],
    messages: [], transcript: [{ role: 'user', text: 'hi', at: '2026-10-28T05:00:01+00:00' }],
  });
  assert.equal(doc.callId, 'web-1');
  assert.equal(doc.channel, 'web');
  assert.equal(doc.callerName, 'Ritu');
  assert.equal(doc.callerPhone, '9830012345');
  assert.equal(doc.urgent, true);
  assert.equal(doc.transcript[0].text, 'hi');
});

test('parses AI-booked calendar events', () => {
  const a = toAppointment({
    id: 'e1', summary: 'Appointment: Kushal Ghosh', htmlLink: 'x',
    start: { dateTime: '2026-10-28T11:15:00+05:30' }, end: { dateTime: '2026-10-28T11:30:00+05:30' },
    description: '[via AI receptionist / UNVERIFIED]\nCaller: Kushal Ghosh\nCallback: +91 98300 12345\nEmail: (none)\nNotes: (none)',
  });
  assert.equal(a.patientName, 'Kushal Ghosh');
  assert.equal(a.phone, '+91 98300 12345');
  assert.equal(a.email, null);
  assert.equal(a.bookedVia, 'AI receptionist');
  assert.equal(a.status, 'confirmed');
  const manual = toAppointment({ id: 'e2', summary: 'Mr Roy checkup', start: { dateTime: 'x' }, end: { dateTime: 'y' } });
  assert.equal(manual.bookedVia, 'Front desk');
  assert.equal(manual.patientName, 'Mr Roy checkup');
});

test('clinic day range is midnight-to-midnight IST', () => {
  const { start, end, ymd } = dayRange('2026-10-28', 'Asia/Kolkata');
  assert.equal(ymd, '2026-10-28');
  assert.equal(start.toISOString(), '2026-10-27T18:30:00.000Z');
  assert.equal(end.toISOString(), '2026-10-28T18:30:00.000Z');
});

test('summary prompt mentions urgency and skips tool lines', () => {
  const p = buildSummaryPrompt({ urgent: true, transcript: [
    { role: 'user', text: 'chest pain' }, { role: 'tool', text: 'report_emergency' }, { role: 'assistant', text: 'call 112' }] });
  assert.match(p, /URGENT/);
  assert.match(p, /Caller: chest pain/);
  assert.doesNotMatch(p, /report_emergency/);
});

test('HTTP: webhook rejects wrong secret, admin API needs login, token endpoint works', async () => {
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await fetch(`${base}/api/webhooks/agent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': 'nope' }, body: '{}' });
    assert.equal(r.status, 401);
    r = await fetch(`${base}/api/admin/dashboard`);
    assert.equal(r.status, 401);
    r = await fetch(`${base}/api/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 200);
    assert.ok((await r.json()).token);
    r = await fetch(`${base}/api/nothing`);
    assert.equal(r.status, 404);
  } finally { server.close(); }
});
