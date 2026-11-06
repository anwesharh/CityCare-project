import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import AdminLayout, { Badge, ErrorNote } from '../components/AdminLayout.jsx';
import { api, fmtDate, fmtDateTime, fmtDuration, fmtTime } from '../api.js';

export default function PatientDetail() {
  const { key } = useParams();
  const [data, setData] = useState(null);
  const [notes, setNotes] = useState('');
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api(`/admin/patients/${key}`).then((d) => { setData(d); setNotes(d.patient.notes || ''); }).catch((e) => setError(e.message));
  }, [key]);

  async function saveNotes(e) {
    e.preventDefault();
    try { await api(`/admin/patients/${key}`, { method: 'PATCH', body: { notes } }); setSaved('Saved'); setTimeout(() => setSaved(''), 2000); }
    catch (err) { setError(err.message); }
  }

  if (!data) return <AdminLayout><ErrorNote error={error} />{!error && <p className="muted">Loading…</p>}</AdminLayout>;
  const { patient, calls, messages, appointments } = data;
  const now = Date.now();

  return (
    <AdminLayout>
      <Link to="/admin/patients" className="link-strong small">← All patients</Link>
      <div><h1 className="h-page">{patient.name || 'Unknown patient'}</h1>
        <span className="muted">{patient.phone || patient.phoneKey}{patient.email ? ` · ${patient.email}` : ''}</span></div>
      <ErrorNote error={error} />

      <div className="split">
        <section className="card grow-3">
          <h2 className="h-card">Appointments</h2>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>When</th><th>Doctor</th><th>Token</th><th>Status</th></tr></thead>
              <tbody>
                {appointments.length === 0 && <tr><td colSpan="4" className="muted">No appointments found.</td></tr>}
                {appointments.map((a) => (
                  <tr key={a.id}>
                    <td><strong>{fmtDate(a.start)}</strong>, {fmtTime(a.start)}</td>
                    <td>{a.doctor || '—'}</td>
                    <td>{a.token || '—'}</td>
                    <td>{new Date(a.start).getTime() >= now ? <Badge kind={a.status === 'rescheduled' ? 'warn' : 'ok'}>Upcoming</Badge> : <span className="muted">Past</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <form className="card grow-2" onSubmit={saveNotes}>
          <h2 className="h-card">Staff notes</h2>
          <label className="field">Private notes (not shared with the patient)
            <textarea rows={6} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. prefers evening slots, follow-up due in March" />
          </label>
          <div className="row gap"><button type="submit" className="btn btn-primary">Save notes</button><span className="muted small" aria-live="polite">{saved}</span></div>
        </form>
      </div>

      <div className="split">
        <section className="card grow-3">
          <h2 className="h-card">Calls</h2>
          {calls.length === 0 && <p className="muted">No calls recorded.</p>}
          {calls.map((c) => (
            <div key={c._id} className="msg">
              <div className="row-between small"><strong>{fmtDateTime(c.startedAt)}</strong><span className="muted">{fmtDuration(c.durationSeconds)}</span></div>
              {c.summary && <p>{c.summary}</p>}
              <div className="row gap">{c.urgent && <Badge kind="danger">Urgent</Badge>}<Link className="link-strong small" to={`/admin/calls/${c._id}`}>Open call</Link></div>
            </div>
          ))}
        </section>
        <section className="card grow-2">
          <h2 className="h-card">Messages</h2>
          {messages.length === 0 && <p className="muted">No messages.</p>}
          {messages.map((m) => (
            <div key={m._id} className="msg"><div className="row-between small"><strong>{fmtDateTime(m.receivedAt)}</strong><span className="muted">{m.status === 'done' ? 'Done' : 'Waiting'}</span></div><p>{m.text}</p></div>
          ))}
        </section>
      </div>
    </AdminLayout>
  );
}
