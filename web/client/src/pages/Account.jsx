import { useState } from 'react';
import AdminLayout, { ErrorNote } from '../components/AdminLayout.jsx';
import { api, auth } from '../api.js';

export default function Account() {
  const user = auth.user || {};
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  async function submit(e) {
    e.preventDefault(); setError(''); setDone('');
    try { await api('/auth/password', { method: 'POST', body: { current, next } }); setDone('Password changed.'); setCurrent(''); setNext(''); }
    catch (err) { setError(err.message); }
  }

  return (
    <AdminLayout>
      <div><h1 className="h-page">My account</h1><span className="muted">{user.email} · {user.role}</span></div>
      <form className="card narrow" onSubmit={submit}>
        <h2 className="h-card">Change password</h2>
        <label className="field">Current password<input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></label>
        <label className="field">New password (at least 8 characters)<input type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required /></label>
        <ErrorNote error={error} />
        {done && <p className="ok-note" role="status">{done}</p>}
        <div><button type="submit" className="btn btn-primary">Change password</button></div>
      </form>
    </AdminLayout>
  );
}
