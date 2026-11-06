import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, auth } from '../api.js';
import { Logo } from '../components/Icons.jsx';
import { useClinic } from '../hooks/useClinic.js';

export default function Login() {
  const navigate = useNavigate();
  const clinic = useClinic();
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
    <div className="login-page">
      <form className="card login-card" onSubmit={submit}>
        <div className="brand"><Logo /><span>{clinic.clinicName}</span></div>
        <div><h1 className="h-card-lg">Staff login</h1><p className="muted">Appointments, messages and call records.</p></div>
        <label className="field">Email
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@citycareclinic.in" />
        </label>
        <label className="field">Password
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error-note" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
        <p className="muted small center">Accounts are created by the clinic admin.</p>
      </form>
    </div>
  );
}
