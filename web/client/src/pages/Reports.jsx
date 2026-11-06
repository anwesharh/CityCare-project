import { useEffect, useState } from 'react';
import AdminLayout, { Badge, ErrorNote } from '../components/AdminLayout.jsx';
import { api, auth, fmtDateTime } from '../api.js';

const STATUS = { processing: ['Processing', 'warn'], ready: ['Ready', 'ok'], collected: ['Collected', 'muted'] };
const blank = { patientName: '', phone: '', test: '', reportNo: '', expectedOn: '', notes: '' };

export default function Reports() {
  const [data, setData] = useState({ reports: [], counts: {} });
  const [filter, setFilter] = useState('processing');
  const [q, setQ] = useState('');
  const [form, setForm] = useState(blank);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const canDelete = ['admin', 'lab'].includes(auth.user?.role);

  const load = () => api(`/admin/reports?status=${filter}&q=${encodeURIComponent(q)}`).then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [filter]); // eslint-disable-line react-hooks/exhaustive-deps

  async function add(e) {
    e.preventDefault(); setError(''); setStatus('');
    try { await api('/admin/reports', { method: 'POST', body: form }); setForm(blank); setStatus('Report added.'); load(); }
    catch (err) { setError(err.message); }
  }
  async function setReport(r, patch) {
    try { await api(`/admin/reports/${r._id}`, { method: 'PATCH', body: patch }); load(); } catch (err) { setError(err.message); }
  }
  async function remove(r) {
    if (!window.confirm(`Delete the ${r.test} report for ${r.patientName}?`)) return;
    try { await api(`/admin/reports/${r._id}`, { method: 'DELETE' }); load(); } catch (err) { setError(err.message); }
  }

  return (
    <AdminLayout>
      <div><h1 className="h-page">Lab reports</h1>
        <span className="muted">Mark a report ready and callers can ask the receptionist “is my report ready?” — it only ever says the status, never results.</span></div>
      <ErrorNote error={error} />
      {status && <p className="ok-note" role="status">{status}</p>}

      <form className="card" onSubmit={add}>
        <h2 className="h-card">Add a report</h2>
        <div className="form-grid">
          <label className="field">Patient name<input value={form.patientName} onChange={(e) => setForm({ ...form, patientName: e.target.value })} required /></label>
          <label className="field">Phone (registered)<input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="98300 12345" required /></label>
          <label className="field">Test / scan<input list="test-list" value={form.test} onChange={(e) => setForm({ ...form, test: e.target.value })} required /></label>
          <label className="field">Bill / report no. (optional)<input value={form.reportNo} onChange={(e) => setForm({ ...form, reportNo: e.target.value })} /></label>
          <label className="field">Expected on<input type="date" value={form.expectedOn} onChange={(e) => setForm({ ...form, expectedOn: e.target.value })} /></label>
          <div><button type="submit" className="btn btn-primary">Add report</button></div>
        </div>
        <TestList />
      </form>

      <section className="card">
        <div className="filters">
          <div className="seg" role="group" aria-label="Status">
            {Object.entries(STATUS).map(([k, [label]]) => (
              <button key={k} type="button" className={`seg-btn${filter === k ? ' active' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                {label} <span className="muted small">{data.counts?.[k] ?? ''}</span></button>
            ))}
          </div>
          <form className="row gap" onSubmit={(e) => { e.preventDefault(); load(); }}>
            <label className="sr-only" htmlFor="rq">Search reports</label>
            <input id="rq" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, phone, test or report no." />
            <button type="submit" className="btn btn-small">Search</button>
          </form>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Patient</th><th>Test</th><th>Added</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {data.reports.length === 0 && <tr><td colSpan="5" className="muted">No reports here.</td></tr>}
              {data.reports.map((r) => (
                <tr key={r._id}>
                  <td><strong>{r.patientName}</strong><br /><span className="muted small">{r.phone}{r.reportNo ? ` · #${r.reportNo}` : ''}</span></td>
                  <td>{r.test}{r.expectedOn && r.status === 'processing' ? <><br /><span className="muted small">Expected {r.expectedOn}</span></> : null}</td>
                  <td className="small">{fmtDateTime(r.createdAt)}</td>
                  <td><Badge kind={STATUS[r.status][1]}>{STATUS[r.status][0]}</Badge></td>
                  <td className="actions">
                    {r.status === 'processing' && <button type="button" className="btn btn-small btn-primary" onClick={() => setReport(r, { status: 'ready' })}>Mark ready</button>}
                    {r.status === 'ready' && <button type="button" className="btn btn-small" onClick={() => setReport(r, { status: 'collected' })}>Mark collected</button>}
                    {r.status !== 'processing' && <button type="button" className="btn btn-small" onClick={() => setReport(r, { status: 'processing' })}>Undo</button>}
                    {canDelete && <button type="button" className="btn btn-small btn-danger-outline" onClick={() => remove(r)}>Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </AdminLayout>
  );
}

function TestList() {
  const [tests, setTests] = useState([]);
  useEffect(() => { api('/admin/settings').then((d) => setTests([...(d.settings.lab?.tests || []), ...(d.settings.lab?.packages || [])].map((t) => t.name))).catch(() => {}); }, []);
  return <datalist id="test-list">{tests.map((t) => <option key={t} value={t} />)}</datalist>;
}
