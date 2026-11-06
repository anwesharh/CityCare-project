import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AdminLayout, { Badge, ErrorNote } from '../components/AdminLayout.jsx';
import { AlertIcon } from '../components/Icons.jsx';
import { api, fmtDate, fmtDateTime, fmtTime } from '../api.js';

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const load = () => api('/admin/dashboard').then((d) => alive && setData(d)).catch((e) => alive && setError(e.message));
    load();
    const t = setInterval(load, 30000); // refresh every 30 s
    return () => { alive = false; clearInterval(t); };
  }, []);

  const stats = data ? [
    { label: 'Calls today', value: data.stats.callsToday },
    { label: 'Appointments today', value: data.stats.appointmentsToday ?? data.appointments.length },
    { label: 'Booked by AI today', value: data.stats.bookedToday },
    { label: 'Cancelled / moved', value: data.stats.changedToday },
    { label: 'Messages waiting', value: data.stats.openMessages },
  ] : [];

  return (
    <AdminLayout>
      <div className="row-between wrap">
        <div><h1 className="h-page">Today</h1><span className="muted">{data ? fmtDate(`${data.date}T12:00:00+05:30`) : 'Loading…'}</span></div>
        <span className="tag">● Auto-refreshes every 30 seconds</span>
      </div>
      <ErrorNote error={error} />

      <div className="stat-grid">
        {stats.map((s) => <div key={s.label} className="card stat"><span>{s.label}</span><strong>{s.value}</strong></div>)}
      </div>

      {data?.urgent?.map((c) => (
        <section key={c._id} aria-label="Urgent call" className="emergency-box">
          <AlertIcon size={28} stroke="#A3261A" />
          <div className="grow">
            <strong>Urgent call needs follow-up</strong>
            <div>{fmtDateTime(c.startedAt)} · {c.urgentKeywords?.join(', ') || 'emergency reported'}
              {c.callerPhone ? ` · callback ${c.callerPhone}` : ''}</div>
          </div>
          <Link to={`/admin/calls/${c._id}`} className="btn btn-danger btn-pill">Open call</Link>
        </section>
      ))}

      <div className="split">
        <section aria-label="Today's appointments" className="card grow-3">
          <div className="row-between"><h2 className="h-card">Today's appointments</h2><Link to="/admin/appointments" className="link-strong small">View all</Link></div>
          {data?.calendarError && <p className="muted">{data.calendarError}</p>}
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Time</th><th>Token</th><th>Patient</th><th>Doctor</th><th>Status</th></tr></thead>
              <tbody>
                {data?.appointments?.length === 0 && <tr><td colSpan="5" className="muted">No appointments today.</td></tr>}
                {data?.appointments?.map((a) => (
                  <tr key={a.id}>
                    <td><strong>{fmtTime(a.start)}</strong></td><td>{a.token ? <span className="token">#{a.token}</span> : '—'}</td>
                    <td>{a.patientName}<br /><span className="muted small">{a.phone || ''}</span></td><td>{a.doctor || '—'}</td>
                    <td><Badge kind={a.status === 'rescheduled' ? 'warn' : 'ok'}>{a.status === 'rescheduled' ? 'Rescheduled' : 'Confirmed'}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-label="Messages" className="card grow-2">
          <div className="row-between"><h2 className="h-card">Messages for callback</h2><Link to="/admin/messages" className="link-strong small">All</Link></div>
          {data?.messages?.length === 0 && <p className="muted">No open messages.</p>}
          {data?.messages?.map((m) => (
            <div key={m._id} className="msg">
              <div className="row-between small"><strong>{m.callerName || 'Unknown caller'}</strong><span className="muted">{fmtDateTime(m.receivedAt)}</span></div>
              <p>{m.text}</p>
              <span className="muted small">{m.callbackNumber}</span>
            </div>
          ))}
        </section>
      </div>
    </AdminLayout>
  );
}
