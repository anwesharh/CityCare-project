import { useEffect, useState } from 'react';
import AdminLayout, { Badge, ErrorNote } from '../components/AdminLayout.jsx';
import { api, auth } from '../api.js';

function QueueCard({ item, onMove }) {
  const [busy, setBusy] = useState(false);
  const move = async (action, value) => { setBusy(true); try { await onMove(item.doctor, action, value); } finally { setBusy(false); } };
  return (
    <div className="card queue-card">
      <div className="row-between">
        <div><strong>{item.doctor}</strong><br />
          <span className="muted small">{[item.department, item.room && `Room ${item.room}`].filter(Boolean).join(' · ') || item.specialty}</span></div>
        {item.onLeave && <Badge kind="warn">On leave</Badge>}
      </div>
      <div className="queue-now"><span className="muted small">Now serving</span><span className="queue-token">{item.nowServing || '—'}</span></div>
      <span className="muted small">
        {item.waiting === null ? 'Waiting count needs Google Calendar' : `${item.waiting} waiting · last token ${item.lastToken || '—'}`}
      </span>
      <div className="row gap">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => move('next')}>Call next</button>
        <button type="button" className="btn btn-small" disabled={busy || !item.nowServing} onClick={() => move('prev')}>Back</button>
        <button type="button" className="btn btn-small" disabled={busy} onClick={() => {
          const v = window.prompt('Set token now serving:', String(item.nowServing || 0));
          if (v !== null) move('set', v);
        }}>Set…</button>
      </div>
    </div>
  );
}

function BedsCard({ canEdit }) {
  const [beds, setBeds] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { api('/admin/beds').then((d) => { setBeds(d.beds); setUpdatedAt(d.updatedAt); }).catch((e) => setError(e.message)); }, []);
  const setBed = (i, patch) => setBeds(beds.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  async function save() {
    setStatus('Saving…'); setError('');
    try { const d = await api('/admin/beds', { method: 'PUT', body: { beds } }); setBeds(d.beds); setUpdatedAt(d.updatedAt); setStatus('Saved. The receptionist uses these from the next call.'); }
    catch (e) { setError(e.message); setStatus(''); }
  }
  if (!beds) return <section className="card"><h2 className="h-card">Beds</h2><ErrorNote error={error} /></section>;
  return (
    <section className="card">
      <div className="row-between wrap">
        <div><h2 className="h-card">Bed availability</h2>
          <span className="muted small">{updatedAt ? `Updated ${new Date(updatedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}` : 'Not updated yet'} · the receptionist gives callers these as approximate numbers</span></div>
        {canEdit && <button type="button" className="btn btn-primary btn-pill" onClick={save}>Save beds</button>}
      </div>
      <ErrorNote error={error} />
      {status && <p className="ok-note" role="status">{status}</p>}
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Ward</th><th>Free beds</th><th>Total</th>{canEdit && <th><span className="sr-only">Actions</span></th>}</tr></thead>
          <tbody>
            {beds.length === 0 && <tr><td colSpan="4" className="muted">No wards yet{canEdit ? ' — add one below' : ''}.</td></tr>}
            {beds.map((b, i) => (
              <tr key={b._id || i}>
                <td>{canEdit ? <input aria-label="Ward name" value={b.ward} onChange={(e) => setBed(i, { ward: e.target.value })} /> : <strong>{b.ward}</strong>}</td>
                <td>{canEdit ? (
                  <span className="row gap">
                    <button type="button" className="btn btn-small" aria-label={`One fewer free bed in ${b.ward}`} onClick={() => setBed(i, { available: Math.max(0, (b.available || 0) - 1) })}>−</button>
                    <input aria-label={`Free beds in ${b.ward}`} className="num-input" type="number" min="0" value={b.available ?? ''} onChange={(e) => setBed(i, { available: e.target.value })} />
                    <button type="button" className="btn btn-small" aria-label={`One more free bed in ${b.ward}`} onClick={() => setBed(i, { available: (Number(b.available) || 0) + 1 })}>+</button>
                  </span>) : <strong>{b.available ?? '—'}</strong>}</td>
                <td>{canEdit ? <input aria-label={`Total beds in ${b.ward}`} className="num-input" type="number" min="0" value={b.total ?? ''} onChange={(e) => setBed(i, { total: e.target.value })} /> : (b.total ?? '—')}</td>
                {canEdit && <td className="actions"><button type="button" className="btn btn-small btn-danger-outline" onClick={() => setBeds(beds.filter((_, j) => j !== i))}>Remove</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && <div><button type="button" className="btn btn-small" onClick={() => setBeds([...beds, { ward: '', available: '', total: '' }])}>+ Add ward</button></div>}
    </section>
  );
}

export default function OpdBoard() {
  const role = auth.user?.role;
  const [q, setQ] = useState(null);
  const [error, setError] = useState('');
  const load = () => api('/admin/queue').then(setQ).catch((e) => setError(e.message));
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, []);
  async function move(doctor, action, value) {
    try { await api('/admin/queue', { method: 'POST', body: { doctor, action, value } }); await load(); }
    catch (e) { setError(e.message); }
  }
  return (
    <AdminLayout>
      <div className="row-between wrap">
        <div><h1 className="h-page">OPD queue{role === 'doctor' || role === 'lab' ? '' : ' & beds'}</h1>
          <span className="muted">Press “Call next” when the next patient goes in. The waiting-room screen and the receptionist update automatically.</span></div>
        <a className="btn btn-pill" href="/queue" target="_blank" rel="noreferrer">Open waiting-room screen</a>
      </div>
      <ErrorNote error={error} />
      <div className="card-grid">
        {q?.items?.length === 0 && <p className="muted">No doctors set up yet.</p>}
        {q?.items?.map((item) => <QueueCard key={item.doctor} item={item} onMove={move} />)}
      </div>
      {(role === 'admin' || role === 'staff') && <BedsCard canEdit />}
    </AdminLayout>
  );
}
