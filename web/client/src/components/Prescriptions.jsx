// Prescription saver: upload a photo/PDF, see the medicines read from it, fix them, set reminder times.
// Used by the patient portal (who="patient") and the staff patient page (who="staff").
import { useEffect, useRef, useState } from 'react';
import { Badge } from './AdminLayout.jsx';
import { api, openFile, patientApi, uploadFile } from '../api.js';

const SLOTS = [['08:00', 'Morning'], ['14:00', 'Afternoon'], ['21:00', 'Night']];
const fmtDay = (ymd) => (ymd ? new Date(`${ymd}T12:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const blankMed = () => ({ name: '', strength: '', dose: '', frequencyText: '', timing: '', durationDays: '', instructions: '', times: [], reminders: false, verified: true });

/** Paths differ for staff and patients; everything else is the same. */
function endpoints(who, patientKey) {
  if (who === 'patient') {
    return {
      call: patientApi,
      list: null,
      upload: '/patient/prescriptions',
      one: (id) => `/prescriptions/${id}`,
      file: (id) => `/patient/prescriptions/${id}/file`,
      ics: (id) => `/patient/prescriptions/${id}/reminders.ics`,
    };
  }
  return {
    call: (p, o) => api(`/admin${p}`, o),
    list: `/patients/${patientKey}/prescriptions`,
    upload: `/admin/patients/${patientKey}/prescriptions`,
    one: (id) => `/prescriptions/${id}`,
    file: (id) => `/admin/prescriptions/${id}/file`,
    ics: null,
  };
}

export function UploadPrescription({ who, patientKey, onAdded }) {
  const ep = endpoints(who, patientKey);
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function pick(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true); setError('');
    try { const { prescription } = await uploadFile(ep.upload, file, who); onAdded(prescription); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <div className="stack-sm">
      <input ref={input} type="file" accept="image/*,application/pdf" className="sr-only" id={`rx-up-${who}`} onChange={pick} />
      <div><label htmlFor={`rx-up-${who}`} className={`btn btn-primary${busy ? ' disabled' : ''}`} aria-disabled={busy}>
        {busy ? 'Uploading…' : '+ Add prescription (photo or PDF)'}</label></div>
      <span className="muted small">Take a clear, well-lit photo of the whole page. Max 8 MB.</span>
      {error && <p className="error-note" role="alert">{error}</p>}
    </div>
  );
}

export function PrescriptionCard({ rx: initial, who, patientKey, onDeleted, canDelete = true }) {
  const ep = endpoints(who, patientKey);
  const [rx, setRx] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState('');
  const [showText, setShowText] = useState(false);

  // While Gemini is reading it, check every 3 s.
  useEffect(() => {
    if (rx.status !== 'reading') return undefined;
    const t = setInterval(() => {
      ep.call(ep.one(rx._id)).then((d) => setRx(d.prescription)).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [rx.status, rx._id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setRx(initial); }, [initial]);

  const startEdit = () => {
    setDraft({ doctor: rx.doctor || '', date: rx.date || '', advice: rx.advice || '',
      medicines: (rx.medicines || []).map((m) => ({ ...m, durationDays: m.durationDays ?? '' })) });
    setEditing(true);
  };
  const setMed = (i, patch) => setDraft((d) => ({ ...d, medicines: d.medicines.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));
  const toggleTime = (i, t) => {
    const m = draft.medicines[i];
    const times = m.times.includes(t) ? m.times.filter((x) => x !== t) : [...m.times, t].sort();
    setMed(i, { times, reminders: times.length > 0 ? (m.times.length ? m.reminders : true) : false });
  };

  async function save(body) {
    setError('');
    try { const { prescription } = await ep.call(ep.one(rx._id), { method: 'PATCH', body }); setRx(prescription); setEditing(false); }
    catch (e) { setError(e.message); }
  }
  async function retry() {
    try { const { prescription } = await ep.call(`${ep.one(rx._id)}/retry`, { method: 'POST' }); setRx(prescription); }
    catch (e) { setError(e.message); }
  }
  async function remove() {
    if (!window.confirm('Delete this prescription and its photo?')) return;
    try { await ep.call(ep.one(rx._id), { method: 'DELETE' }); onDeleted?.(rx._id); } catch (e) { setError(e.message); }
  }
  const toggleReminder = (i) => save({ medicines: rx.medicines.map((m, j) => (j === i ? { ...m, reminders: !m.reminders } : m)) });

  const unverified = (rx.medicines || []).some((m) => m.verified === false);

  return (
    <article className="card rx-card">
      <div className="row-between wrap">
        <div>
          <strong>{rx.doctor || 'Prescription'}</strong>
          <span className="muted small"> · {fmtDay(rx.date) || new Date(rx.createdAt).toLocaleDateString('en-IN')}
            {rx.source === 'staff' ? ' · added by the hospital' : ''}</span>
        </div>
        <div className="row gap">
          {rx.status === 'reading' && <Badge kind="warn">Reading…</Badge>}
          {rx.status === 'failed' && <Badge kind="danger">Couldn't read</Badge>}
          {rx.file && <button type="button" className="btn btn-small" onClick={() => openFile(ep.file(rx._id), who).catch((e) => setError(e.message))}>View original</button>}
        </div>
      </div>

      {rx.status === 'reading' && <p className="muted">Reading the medicines from your prescription. This takes about 10–20 seconds…</p>}
      {rx.status === 'failed' && <p className="muted">{rx.error}</p>}
      {error && <p className="error-note" role="alert">{error}</p>}

      {!editing && rx.medicines?.length > 0 && (
        <div className="table-wrap">
          <table className="table rx-table">
            <thead><tr><th>Medicine</th><th>How to take</th><th>For</th><th>Reminders</th></tr></thead>
            <tbody>
              {rx.medicines.map((m, i) => (
                <tr key={m._id || i}>
                  <td><strong>{m.name}</strong>{m.strength ? ` ${m.strength}` : ''}
                    {m.category && <><br /><span className="muted small">{m.category}</span></>}
                    {m.verified === false && <><br /><Badge kind="warn">Please check</Badge></>}</td>
                  <td>{[m.dose, m.frequencyText, m.timing].filter(Boolean).join(' · ') || '—'}
                    {m.instructions && <><br /><span className="muted small">{m.instructions}</span></>}</td>
                  <td>{m.durationDays ? `${m.durationDays} days` : '—'}</td>
                  <td>{m.times?.length ? (
                    <label className="check small"><input type="checkbox" checked={Boolean(m.reminders)} onChange={() => toggleReminder(i)} />
                      {m.times.join(', ')}</label>) : <span className="muted small">{/sos|prn/i.test(m.frequencyText || '') ? 'Only when needed' : 'No times'}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!editing && rx.advice && <p><strong>Advice:</strong> {rx.advice}</p>}
      {!editing && unverified && <p className="muted small">Medicines marked “Please check” weren't clearly found in the text that was read. Compare them with the original.</p>}

      {editing && draft && (
        <div className="stack">
          <div className="form-grid">
            <label className="field">Doctor<input value={draft.doctor} onChange={(e) => setDraft({ ...draft, doctor: e.target.value })} /></label>
            <label className="field">Date<input type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} /></label>
          </div>
          {draft.medicines.map((m, i) => (
            <div key={m._id || i} className="list-edit rx-edit">
              <label className="field">Medicine<input value={m.name} onChange={(e) => setMed(i, { name: e.target.value })} required /></label>
              <label className="field">Strength<input value={m.strength || ''} onChange={(e) => setMed(i, { strength: e.target.value })} placeholder="500 mg" /></label>
              <label className="field">Dose<input value={m.dose || ''} onChange={(e) => setMed(i, { dose: e.target.value })} placeholder="1 tablet" /></label>
              <label className="field">Food<select value={m.timing || ''} onChange={(e) => setMed(i, { timing: e.target.value })}>
                <option value="">—</option><option>before food</option><option>after food</option></select></label>
              <label className="field">Days<input type="number" min="1" max="365" value={m.durationDays} onChange={(e) => setMed(i, { durationDays: e.target.value })} /></label>
              <fieldset className="field rx-times"><legend>Reminder times</legend>
                <div className="row gap wrap">
                  {SLOTS.map(([t, label]) => (
                    <label key={t} className="check small"><input type="checkbox" checked={m.times.includes(t)} onChange={() => toggleTime(i, t)} />{label}</label>
                  ))}
                  <input type="time" aria-label="Add another time" className="num-input" onChange={(e) => { if (e.target.value && !m.times.includes(e.target.value)) toggleTime(i, e.target.value); e.target.value = ''; }} />
                </div>
                {m.times.filter((t) => !SLOTS.some(([s]) => s === t)).map((t) => (
                  <button key={t} type="button" className="btn btn-small" onClick={() => toggleTime(i, t)}>{t} ✕</button>
                ))}
              </fieldset>
              <button type="button" className="btn btn-small btn-danger-outline" onClick={() => setDraft({ ...draft, medicines: draft.medicines.filter((_, j) => j !== i) })}>Remove</button>
            </div>
          ))}
          <div><button type="button" className="btn btn-small" onClick={() => setDraft({ ...draft, medicines: [...draft.medicines, blankMed()] })}>+ Add medicine</button></div>
          <label className="field">Advice<textarea rows={2} value={draft.advice} onChange={(e) => setDraft({ ...draft, advice: e.target.value })} /></label>
          <div className="row gap">
            <button type="button" className="btn btn-primary" onClick={() => save({ ...draft, medicines: draft.medicines.map((m) => ({ ...m, verified: true })) })}>Save</button>
            <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}

      {!editing && rx.status !== 'reading' && (
        <div className="row gap wrap">
          <button type="button" className="btn btn-small" onClick={startEdit}>{rx.medicines?.length ? 'Edit medicines' : 'Add medicines by hand'}</button>
          {rx.status === 'failed' && rx.file && <button type="button" className="btn btn-small" onClick={retry}>Try reading again</button>}
          {ep.ics && rx.medicines?.some((m) => m.reminders) && (
            <button type="button" className="btn btn-small btn-primary" onClick={() => openFile(ep.ics(rx._id), who, { download: true, filename: 'medicine-reminders.ics' }).catch((e) => setError(e.message))}>
              Add reminders to phone calendar</button>)}
          {rx.text && <button type="button" className="btn btn-small" aria-expanded={showText} onClick={() => setShowText(!showText)}>{showText ? 'Hide' : 'Show'} text read</button>}
          {canDelete && <button type="button" className="btn btn-small btn-danger-outline" onClick={remove}>Delete</button>}
        </div>
      )}
      {showText && <pre className="rx-text">{rx.text}</pre>}
    </article>
  );
}

/** Staff view: list + upload for one patient. */
export function StaffPrescriptions({ patientKey, canDelete }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api(`/admin/patients/${patientKey}/prescriptions`).then((d) => setList(d.prescriptions)).catch((e) => setError(e.message)); }, [patientKey]);
  return (
    <section className="card">
      <div className="row-between wrap"><h2 className="h-card">Prescriptions</h2>
        <UploadPrescription who="staff" patientKey={patientKey} onAdded={(rx) => setList((l) => [rx, ...(l || [])])} /></div>
      <p className="muted small">The patient sees these in their patient portal and can set medicine reminders.</p>
      {error && <p className="error-note" role="alert">{error}</p>}
      {list?.length === 0 && <p className="muted">No prescriptions yet.</p>}
      {list?.map((rx) => <PrescriptionCard key={rx._id} rx={rx} who="staff" patientKey={patientKey} canDelete={canDelete}
        onDeleted={(id) => setList((l) => l.filter((x) => x._id !== id))} />)}
    </section>
  );
}
