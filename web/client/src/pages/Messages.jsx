import { useEffect, useState } from 'react';
import AdminLayout, { ErrorNote } from '../components/AdminLayout.jsx';
import { api, fmtDateTime } from '../api.js';

export default function Messages() {
  const [status, setStatus] = useState('open');
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');

  const load = () => api(`/admin/messages?status=${status}`).then((d) => setItems(d.messages)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function mark(m, next) {
    try { await api(`/admin/messages/${m._id}`, { method: 'PATCH', body: { status: next } }); load(); } catch (e) { setError(e.message); }
  }

  return (
    <AdminLayout>
      <div className="row-between wrap">
        <h1 className="h-page">Messages</h1>
        <div role="group" aria-label="Filter" className="row gap">
          {['open', 'done', 'all'].map((s) => (
            <button key={s} type="button" className={`btn btn-pill ${status === s ? 'btn-primary' : ''}`} onClick={() => setStatus(s)}>
              {s === 'open' ? 'Waiting' : s === 'done' ? 'Done' : 'All'}
            </button>
          ))}
        </div>
      </div>
      <ErrorNote error={error} />
      <div className="stack">
        {items.length === 0 && <p className="muted">Nothing here.</p>}
        {items.map((m) => (
          <div key={m._id} className="card msg-row">
            <div className="grow">
              <div className="row-between small"><strong>{m.callerName || 'Unknown caller'}</strong><span className="muted">{fmtDateTime(m.receivedAt)}</span></div>
              <p>{m.text}</p>
              <span className="muted small">Callback: {m.callbackNumber || '—'}</span>
            </div>
            <div className="row gap">
              {m.status === 'open'
                ? <button type="button" className="btn btn-small btn-primary" onClick={() => mark(m, 'done')}>Mark done</button>
                : <button type="button" className="btn btn-small" onClick={() => mark(m, 'open')}>Reopen</button>}
            </div>
          </div>
        ))}
      </div>
    </AdminLayout>
  );
}
