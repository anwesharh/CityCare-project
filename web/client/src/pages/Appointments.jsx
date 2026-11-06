import { useCallback, useEffect, useState } from 'react';
import AdminLayout, { Badge, ErrorNote } from '../components/AdminLayout.jsx';
import { api, auth, fmtDate, fmtTime, todayIST } from '../api.js';
import { CLINIC } from '../clinic.js';

export default function Appointments() {
  const [from, setFrom] = useState(todayIST());
  const [q, setQ] = useState('');
  const [doctor, setDoctor] = useState('');
  const [doctors, setDoctors] = useState([]);
  const isDoctor = auth.user?.role === 'doctor';
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [moving, setMoving] = useState(null); // appointment being rescheduled
  const [newTime, setNewTime] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ from });
      if (q.trim()) params.set('q', q.trim());
      if (doctor) params.set('doctor', doctor);
      const { appointments } = await api(`/admin/appointments?${params}`);
      setItems(appointments);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }, [from, q, doctor]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api('/admin/settings').then((d) => setDoctors((d.settings.doctors || []).map((x) => x.name))).catch(() => {});
  }, []);

  async function cancel(a) {
    if (!window.confirm(`Cancel ${a.patientName}'s appointment on ${fmtDate(a.start)} at ${fmtTime(a.start)}?`)) return;
    try { await api(`/admin/appointments/${a.id}`, { method: 'DELETE' }); load(); } catch (e) { setError(e.message); }
  }

  async function saveMove(e) {
    e.preventDefault();
    try {
      await api(`/admin/appointments/${moving.id}`, { method: 'PATCH', body: { start: `${newTime}:00${CLINIC.tzOffset}` } });
      setMoving(null); load();
    } catch (err) { setError(err.message); }
  }

  return (
    <AdminLayout>
      <div className="row-between wrap">
        <div><h1 className="h-page">Appointments</h1><span className="muted">{isDoctor ? `Your appointments, ${auth.user?.doctorName}` : 'Live from the clinic Google Calendar'} · next 30 days</span></div>
      </div>

      <form className="filters" onSubmit={(e) => { e.preventDefault(); load(); }}>
        <label className="field grow">Search
          <input type="search" placeholder="Name or phone number" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="field">From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        {!isDoctor && doctors.length > 0 && (
          <label className="field">Doctor
            <select value={doctor} onChange={(e) => setDoctor(e.target.value)}>
              <option value="">All doctors</option>{doctors.map((d) => <option key={d}>{d}</option>)}
            </select>
          </label>
        )}
        <button type="submit" className="btn btn-primary">Search</button>
      </form>
      <ErrorNote error={error} />

      <section aria-label="Appointment list" className="card table-wrap">
        <table className="table">
          <thead><tr><th>Date &amp; time</th><th>Token</th><th>Patient</th><th>Phone</th><th>Doctor</th><th>Booked via</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {loading && <tr><td colSpan="8" className="muted">Loading…</td></tr>}
            {!loading && items.length === 0 && <tr><td colSpan="8" className="muted">No appointments found.</td></tr>}
            {items.map((a) => (
              <tr key={a.id}>
                <td><strong>{fmtTime(a.start)}</strong><br /><span className="muted small">{fmtDate(a.start)}</span></td>
                <td>{a.token ? <span className="token">#{a.token}</span> : '—'}</td>
                <td>{a.patientName}{a.notes && <><br /><span className="muted small">{a.notes}</span></>}</td>
                <td>{a.phone || '—'}</td>
                <td>{a.doctor || '—'}</td>
                <td>{a.bookedVia}</td>
                <td><Badge kind={a.status === 'rescheduled' ? 'warn' : 'ok'}>{a.status === 'rescheduled' ? 'Rescheduled' : 'Confirmed'}</Badge></td>
                <td className="actions">
                  <button type="button" className="btn btn-small" onClick={() => { setMoving(a); setNewTime(''); }}>Reschedule</button>
                  <button type="button" className="btn btn-small btn-danger-outline" onClick={() => cancel(a)}>Cancel</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {moving && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="move-title">
          <form className="card modal" onSubmit={saveMove}>
            <h2 id="move-title" className="h-card">Reschedule {moving.patientName}</h2>
            <p className="muted">Currently {fmtDate(moving.start)} at {fmtTime(moving.start)}</p>
            <label className="field">New date &amp; time (clinic time)
              <input type="datetime-local" required value={newTime} onChange={(e) => setNewTime(e.target.value)} />
            </label>
            <div className="row-end">
              <button type="button" className="btn" onClick={() => setMoving(null)}>Close</button>
              <button type="submit" className="btn btn-primary">Move appointment</button>
            </div>
          </form>
        </div>
      )}
    </AdminLayout>
  );
}
