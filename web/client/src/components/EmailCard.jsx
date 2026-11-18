// Settings card: is patient-login email set up, and a button to send a test email.
import { useEffect, useState } from 'react';
import { api, auth } from '../api.js';

export function EmailCard() {
  const [configured, setConfigured] = useState(null);
  const [to, setTo] = useState(auth.user?.email || '');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { api('/admin/email-status').then((d) => setConfigured(d.configured)).catch(() => {}); }, []);
  async function test() {
    setMsg(''); setError('');
    try { const r = await api('/admin/email-test', { method: 'POST', body: { to } }); setMsg(`Sent to ${r.to}. Check the inbox (and spam).`); }
    catch (e) { setError(e.message); }
  }
  return (
    <section className="card">
      <h2 className="h-card">Patient login emails</h2>
      {configured === null ? <p className="muted">Checking…</p> : configured ? (
        <>
          <p className="ok-note">Email is set up. Patients get their login code by email.</p>
          <div className="row gap wrap">
            <label className="field grow">Send a test email to<input type="email" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            <button type="button" className="btn" onClick={test}>Send test email</button>
          </div>
        </>
      ) : (
        <p className="muted">Not set up yet, so patient login codes are printed in the website window (test mode). To send real emails, add
          <code> SMTP_USER</code> (your Gmail address) and <code>SMTP_PASS</code> (a Gmail app password) to <code>server/.env</code>, then restart <code>npm run dev</code>.</p>
      )}
      {msg && <p className="ok-note" role="status">{msg}</p>}
      {error && <p className="error-note" role="alert">{error}</p>}
    </section>
  );
}
