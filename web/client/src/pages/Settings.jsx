import { useEffect, useState } from 'react';
import AdminLayout, { ErrorNote } from '../components/AdminLayout.jsx';
import { api } from '../api.js';
import {
  DepartmentDatalist, DepartmentsSection, DoctorHospitalFields, EmergencySection, LabSection, SampleHospitalButton,
} from '../components/HospitalSettings.jsx';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const blankDoctor = () => ({ name: '', specialty: '', fee: '', days: '', slotMinutes: 15, useOwnHours: false, hours: {}, leaveDates: [], active: true, department: '', room: '', substitute: '' });

function HoursEditor({ value = {}, onChange, idPrefix }) {
  const set = (day, patch) => onChange({ ...value, [day]: patch });
  return (
    <div className="hours-grid">
      {DAYS.map((d) => {
        const v = value?.[d];
        const open = Boolean(v?.open && v?.close);
        return (
          <div key={d} className="hours-row">
            <label className="check"><input type="checkbox" checked={open}
              onChange={(e) => set(d, e.target.checked ? { open: '10:00', close: '18:00' } : null)} /> {cap(d)}</label>
            {open ? (
              <span className="row gap">
                <label className="sr-only" htmlFor={`${idPrefix}-${d}-o`}>{cap(d)} opens</label>
                <input id={`${idPrefix}-${d}-o`} type="time" value={v.open} onChange={(e) => set(d, { ...v, open: e.target.value })} />
                <span className="muted">to</span>
                <label className="sr-only" htmlFor={`${idPrefix}-${d}-c`}>{cap(d)} closes</label>
                <input id={`${idPrefix}-${d}-c`} type="time" value={v.close} onChange={(e) => set(d, { ...v, close: e.target.value })} />
              </span>
            ) : <span className="muted">Closed</span>}
          </div>
        );
      })}
    </div>
  );
}

export default function Settings() {
  const [s, setS] = useState(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [leaveDraft, setLeaveDraft] = useState({});

  useEffect(() => { api('/admin/settings').then((d) => setS(d.settings)).catch((e) => setError(e.message)); }, []);
  const set = (patch) => setS((prev) => ({ ...prev, ...patch }));
  const setDoc = (i, patch) => set({ doctors: s.doctors.map((d, j) => (j === i ? { ...d, ...patch } : d)) });
  const setFaq = (i, patch) => set({ faqs: s.faqs.map((f, j) => (j === i ? { ...f, ...patch } : f)) });

  async function save(e) {
    e.preventDefault();
    setStatus('Saving…'); setError('');
    try {
      const { settings } = await api('/admin/settings', { method: 'PUT', body: s });
      setS(settings);
      setStatus('Saved. The receptionist uses these from the next call.');
    } catch (err) { setError(err.message); setStatus(''); }
  }

  if (!s) return <AdminLayout><ErrorNote error={error} />{!error && <p className="muted">Loading…</p>}</AdminLayout>;

  return (
    <AdminLayout>
      <form className="stack" onSubmit={save}>
        <div className="row-between wrap">
          <div><h1 className="h-page">Settings</h1><span className="muted">Changes apply to the website and the AI receptionist</span></div>
          <div className="row gap"><SampleHospitalButton s={s} setS={setS} />
            <button type="submit" className="btn btn-primary btn-pill">Save changes</button></div>
        </div>
        <ErrorNote error={error} />
        {status && <p className="ok-note" role="status">{status}</p>}

        <section className="card">
          <h2 className="h-card">Clinic / hospital details</h2>
          <div className="form-grid">
            <label className="field">Name<input value={s.clinicName || ''} onChange={(e) => set({ clinicName: e.target.value })} required /></label>
            <label className="field">Languages shown on website<input value={s.languages || ''} onChange={(e) => set({ languages: e.target.value })} /></label>
            <label className="field">Address line 1<input value={s.addressLines?.[0] || ''} onChange={(e) => set({ addressLines: [e.target.value, s.addressLines?.[1] || ''] })} /></label>
            <label className="field">Address line 2<input value={s.addressLines?.[1] || ''} onChange={(e) => set({ addressLines: [s.addressLines?.[0] || '', e.target.value] })} /></label>
            <label className="field">Payments<input value={s.payments || ''} onChange={(e) => set({ payments: e.target.value })} /></label>
            <label className="field">Google Maps embed link (optional)<input value={s.mapEmbedUrl || ''} onChange={(e) => set({ mapEmbedUrl: e.target.value })} placeholder="https://www.google.com/maps/embed?..." /></label>
          </div>
        </section>

        <section className="card">
          <h2 className="h-card">What the receptionist says</h2>
          <label className="field">Greeting<textarea rows={2} value={s.greeting || ''} onChange={(e) => set({ greeting: e.target.value })} /></label>
          <label className="field">When the clinic is closed<textarea rows={2} value={s.afterHoursMessage || ''} onChange={(e) => set({ afterHoursMessage: e.target.value })} /></label>
          <label className="field">Extra instructions (optional)
            <textarea rows={3} value={s.extraInstructions || ''} onChange={(e) => set({ extraInstructions: e.target.value })}
              placeholder="e.g. Always mention that fasting is needed before blood tests." />
          </label>
        </section>

        <section className="card">
          <h2 className="h-card">OPD hours</h2>
          <HoursEditor idPrefix="clinic" value={s.hours} onChange={(hours) => set({ hours })} />
        </section>

        <DepartmentsSection s={s} set={set} />
        <DepartmentDatalist s={s} />

        <section className="card">
          <div className="row-between"><h2 className="h-card">Doctors</h2>
            <button type="button" className="btn btn-small" onClick={() => set({ doctors: [...s.doctors, blankDoctor()] })}>+ Add doctor</button></div>
          {s.doctors.length === 0 && <p className="muted">No doctors yet. Without doctors, bookings go into one shared schedule.</p>}
          {s.doctors.map((d, i) => (
            <fieldset key={d._id || i} className="doctor-edit">
              <legend>{d.name || 'New doctor'}</legend>
              <div className="form-grid">
                <label className="field">Name<input value={d.name} onChange={(e) => setDoc(i, { name: e.target.value })} placeholder="Dr. Sen" required /></label>
                <label className="field">Specialty<input value={d.specialty || ''} onChange={(e) => setDoc(i, { specialty: e.target.value })} placeholder="General physician" /></label>
                <label className="field">Fee<input value={d.fee || ''} onChange={(e) => setDoc(i, { fee: e.target.value })} placeholder="₹500" /></label>
                <label className="field">Days (shown on website)<input value={d.days || ''} onChange={(e) => setDoc(i, { days: e.target.value })} placeholder="Weekday evenings" /></label>
                <label className="field">Appointment length (minutes)<input type="number" min="5" max="240" value={d.slotMinutes || 15} onChange={(e) => setDoc(i, { slotMinutes: Number(e.target.value) })} /></label>
                <label className="check"><input type="checkbox" checked={d.active !== false} onChange={(e) => setDoc(i, { active: e.target.checked })} /> Taking bookings</label>
              </div>
              <DoctorHospitalFields d={d} i={i} s={s} setDoc={setDoc} />
              <label className="check"><input type="checkbox" checked={Boolean(d.useOwnHours)} onChange={(e) => setDoc(i, { useOwnHours: e.target.checked })} /> Has own working hours (otherwise clinic hours)</label>
              {d.useOwnHours && <HoursEditor idPrefix={`doc${i}`} value={d.hours} onChange={(hours) => setDoc(i, { hours })} />}
              <div className="leave">
                <span className="field-label">Leave days (no bookings)</span>
                <div className="row gap">
                  {(d.leaveDates || []).map((ld) => (
                    <span key={ld} className="chip">{ld}
                      <button type="button" className="chip-x" aria-label={`Remove leave on ${ld}`}
                        onClick={() => setDoc(i, { leaveDates: d.leaveDates.filter((x) => x !== ld) })}>×</button></span>
                  ))}
                  <label className="sr-only" htmlFor={`leave-${i}`}>Add leave date</label>
                  <input id={`leave-${i}`} type="date" value={leaveDraft[i] || ''} onChange={(e) => setLeaveDraft({ ...leaveDraft, [i]: e.target.value })} />
                  <button type="button" className="btn btn-small" disabled={!leaveDraft[i]}
                    onClick={() => { setDoc(i, { leaveDates: [...new Set([...(d.leaveDates || []), leaveDraft[i]])].sort() }); setLeaveDraft({ ...leaveDraft, [i]: '' }); }}>Add leave</button>
                </div>
              </div>
              <button type="button" className="btn btn-small btn-danger-outline" onClick={() => set({ doctors: s.doctors.filter((_, j) => j !== i) })}>Remove doctor</button>
            </fieldset>
          ))}
        </section>

        <EmergencySection s={s} set={set} />
        <LabSection s={s} set={set} HoursEditor={HoursEditor} />

        <section className="card">
          <div className="row-between"><h2 className="h-card">Questions the receptionist can answer</h2>
            <button type="button" className="btn btn-small" onClick={() => set({ faqs: [...s.faqs, { question: '', answer: '' }] })}>+ Add question</button></div>
          {s.faqs.map((f, i) => (
            <div key={f._id || i} className="faq-edit">
              <label className="field">Question<input value={f.question} onChange={(e) => setFaq(i, { question: e.target.value })} /></label>
              <label className="field">Answer<textarea rows={2} value={f.answer} onChange={(e) => setFaq(i, { answer: e.target.value })} /></label>
              <button type="button" className="btn btn-small btn-danger-outline" onClick={() => set({ faqs: s.faqs.filter((_, j) => j !== i) })}>Remove</button>
            </div>
          ))}
        </section>

        <div className="row-end"><button type="submit" className="btn btn-primary btn-pill">Save changes</button></div>
      </form>
    </AdminLayout>
  );
}
