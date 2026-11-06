import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AdminLayout, { Badge, ErrorNote } from '../components/AdminLayout.jsx';
import { api, fmtDateTime, fmtDuration } from '../api.js';

const OUTCOME_LABEL = {
  appointment_booked: 'Booked', appointment_cancelled: 'Cancelled', appointment_rescheduled: 'Rescheduled',
  message_taken: 'Message', transferred: 'Transferred', hung_up: 'Hung up', agent_ended: 'Completed',
  intake_submitted: 'Intake',
};

export default function Calls() {
  const [calls, setCalls] = useState([]);
  const [urgentOnly, setUrgentOnly] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api(`/admin/calls${urgentOnly ? '?urgent=true' : ''}`).then((d) => setCalls(d.calls)).catch((e) => setError(e.message));
  }, [urgentOnly]);

  return (
    <AdminLayout>
      <div className="row-between wrap">
        <h1 className="h-page">Calls &amp; transcripts</h1>
        <label className="check"><input type="checkbox" checked={urgentOnly} onChange={(e) => setUrgentOnly(e.target.checked)} /> Urgent only</label>
      </div>
      <ErrorNote error={error} />
      <section className="card table-wrap">
        <table className="table">
          <thead><tr><th>When</th><th>Caller</th><th>Channel</th><th>Length</th><th>Outcome</th><th><span className="sr-only">Open</span></th></tr></thead>
          <tbody>
            {calls.length === 0 && <tr><td colSpan="6" className="muted">No calls yet. Make a test call from the website.</td></tr>}
            {calls.map((c) => (
              <tr key={c._id}>
                <td><strong>{fmtDateTime(c.startedAt)}</strong></td>
                <td>{c.callerName || 'Unknown'}{c.callerPhone && <><br /><span className="muted small">{c.callerPhone}</span></>}</td>
                <td>{c.channel === 'phone' ? 'Phone' : 'Website'}</td>
                <td>{fmtDuration(c.durationSeconds)}</td>
                <td className="badges">
                  {c.urgent && <Badge kind="danger">Urgent</Badge>}
                  {(c.outcomes || []).map((o) => <Badge key={o} kind="ok">{OUTCOME_LABEL[o] || o}</Badge>)}
                </td>
                <td><Link to={`/admin/calls/${c._id}`} className="link-strong">Open</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </AdminLayout>
  );
}
