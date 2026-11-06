import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AdminLayout, { ErrorNote } from '../components/AdminLayout.jsx';
import { api, fmtDate, fmtDateTime, fmtTime } from '../api.js';

export default function Patients() {
  const [q, setQ] = useState('');
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');

  const load = (query = q) => api(`/admin/patients${query ? `?q=${encodeURIComponent(query)}` : ''}`)
    .then((d) => setItems(d.patients)).catch((e) => setError(e.message));
  useEffect(() => { load(''); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <AdminLayout>
      <div><h1 className="h-page">Patients</h1><span className="muted">Built automatically from calls, messages and bookings</span></div>
      <form className="filters" onSubmit={(e) => { e.preventDefault(); load(); }}>
        <label className="field grow">Search
          <input type="search" placeholder="Name or phone number" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-primary">Search</button>
      </form>
      <ErrorNote error={error} />
      <section className="card table-wrap">
        <table className="table">
          <thead><tr><th>Patient</th><th>Phone</th><th>Next appointment</th><th>Visits</th><th>Calls</th><th>Last contact</th><th><span className="sr-only">Open</span></th></tr></thead>
          <tbody>
            {items === null && <tr><td colSpan="7" className="muted">Loading…</td></tr>}
            {items?.length === 0 && <tr><td colSpan="7" className="muted">No patients yet. They appear after the first call or booking.</td></tr>}
            {items?.map((p) => (
              <tr key={p.phoneKey}>
                <td><strong>{p.name || 'Unknown'}</strong></td>
                <td>{p.phone || p.phoneKey}</td>
                <td>{p.nextAppointment ? <>{fmtDate(p.nextAppointment.start)}, {fmtTime(p.nextAppointment.start)}
                  {p.nextAppointment.doctor && <><br /><span className="muted small">{p.nextAppointment.doctor}</span></>}</> : '—'}</td>
                <td>{p.visits}</td>
                <td>{p.calls}</td>
                <td>{fmtDateTime(p.lastSeenAt)}</td>
                <td><Link className="link-strong" to={`/admin/patients/${p.phoneKey}`}>Open</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </AdminLayout>
  );
}
