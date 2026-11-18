// One login page for everyone: "Patient" (mobile number + email code) and "Staff" (email + password).
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, auth, patientApi, patientAuth } from '../api.js';
import { Logo } from '../components/Icons.jsx';
import { useClinic } from '../hooks/useClinic.js';

function StaffForm() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const { token } = await api('/auth/login', { method: 'POST', body: { email, password } });
      auth.set(token);
      navigate('/admin');
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <p className="muted">Appointments, patients, reports and call records.</p>
      <label className="field">Email
        <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@citycare.in" />
      </label>
      <label className="field">Password
        <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && <p className="error-note" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
      <p className="muted small center">Staff accounts are created by the hospital admin.</p>
    </form>
  );
}

function PatientForm() {
  const navigate = useNavigate();
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState('phone'); // phone → (email, first time only) → code
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function requestCode(e) {
    e?.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await patientApi('/request-code', { method: 'POST', body: { phone, email: step === 'email' ? email : undefined, name } });
      if (r.needsEmail) { setStep('email'); return; }
      setInfo(r.devMode
        ? 'Test mode: email is not set up on the server yet, so the code is printed in the website window (the one running npm run dev).'
        : `We emailed a 6-digit code to ${r.sentTo}. Check your inbox (and spam). It expires in 10 minutes.`);
      setStep('code');
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function verify(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const { token } = await patientApi('/verify', { method: 'POST', body: { phone, code } });
      patientAuth.set(token);
      navigate('/patient');
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <form className="stack" onSubmit={step === 'code' ? verify : requestCode}>
      <p className="muted">Your appointments, reports and prescriptions in one place.</p>
      <label className="field">Mobile number
        <input type="tel" inputMode="numeric" autoComplete="tel" required value={phone} disabled={step !== 'phone'}
          onChange={(e) => setPhone(e.target.value)} placeholder="98300 12345" />
      </label>

      {step === 'email' && (
        <>
          <p className="ok-note" role="status">First time here? Add your email. We'll send a code to check it, and use it for future logins.</p>
          <label className="field">Your name<input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field">Email<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@gmail.com" autoFocus /></label>
        </>
      )}

      {step === 'code' && (
        <>
          <p className="ok-note" role="status">{info}</p>
          <label className="field">6-digit code
            <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
          </label>
        </>
      )}

      {error && <p className="error-note" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy ? 'Please wait…' : step === 'code' ? 'Log in' : 'Send login code'}
      </button>
      {step !== 'phone' && (
        <div className="row-between small">
          <button type="button" className="link-btn" onClick={() => { setStep('phone'); setCode(''); setInfo(''); setError(''); }}>Change number</button>
          {step === 'code' && <button type="button" className="link-btn" onClick={requestCode} disabled={busy}>Send a new code</button>}
        </div>
      )}
      <p className="muted small center">No password needed. Use the mobile number you gave the hospital.</p>
    </form>
  );
}

export default function Login({ initial = 'patient' }) {
  const clinic = useClinic();
  const [tab, setTab] = useState(initial);
  return (
    <div className="login-page">
      <div className="card login-card">
        <Link to="/" className="brand"><Logo /><span>{clinic.clinicName}</span></Link>
        <h1 className="h-card-lg">Log in</h1>
        <div className="seg seg-full" role="tablist" aria-label="Who is logging in">
          {[['patient', 'Patient'], ['staff', 'Hospital staff']].map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={`seg-btn${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>
        {tab === 'patient' ? <PatientForm /> : <StaffForm />}
      </div>
    </div>
  );
}
