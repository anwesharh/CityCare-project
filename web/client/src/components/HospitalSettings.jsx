// Hospital sections of the settings page: departments, emergency, visiting, insurance, lab tests & packages.
import { useState } from 'react';
import { api } from '../api.js';

const blankTest = () => ({ name: '', price: '', prep: '', reportTime: '' });
const blankPackage = () => ({ name: '', price: '', includes: '', prep: '' });

function ListEditor({ items, onChange, blank, fields, addLabel, emptyText }) {
  const setItem = (i, patch) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div className="stack">
      {items.length === 0 && <p className="muted">{emptyText}</p>}
      {items.map((it, i) => (
        <div key={it._id || i} className="list-edit">
          {fields.map((f) => (
            <label key={f.key} className="field">{f.label}
              <input value={it[f.key] || ''} placeholder={f.placeholder} required={f.required}
                onChange={(e) => setItem(i, { [f.key]: e.target.value })} />
            </label>
          ))}
          <button type="button" className="btn btn-small btn-danger-outline" onClick={() => onChange(items.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <div><button type="button" className="btn btn-small" onClick={() => onChange([...items, blank()])}>{addLabel}</button></div>
    </div>
  );
}

export function SampleHospitalButton({ s, setS }) {
  const [busy, setBusy] = useState(false);
  async function fill() {
    if (!window.confirm('Fill departments, emergency numbers, visiting hours, insurance, lab tests and packages with sample hospital data? Your doctors and FAQs stay as they are. Nothing is saved until you press Save.')) return;
    setBusy(true);
    try {
      const { sample } = await api('/admin/settings/sample-hospital');
      const { beds, ...rest } = sample; // bed counts are edited on the OPD & beds page
      setS({ ...s, ...rest });
    } finally { setBusy(false); }
  }
  return <button type="button" className="btn btn-small" onClick={fill} disabled={busy}>Fill sample hospital data</button>;
}

export function DepartmentsSection({ s, set }) {
  return (
    <section className="card">
      <div><h2 className="h-card">Departments</h2>
        <span className="muted small">The receptionist suggests a department from what the caller describes. Put each doctor in a department below.</span></div>
      <ListEditor items={s.departments || []} onChange={(departments) => set({ departments })} blank={() => ({ name: '', description: '', location: '' })}
        addLabel="+ Add department" emptyText="No departments yet (clinic mode)."
        fields={[
          { key: 'name', label: 'Name', placeholder: 'Orthopaedics', required: true },
          { key: 'description', label: 'Treats', placeholder: 'Bones, joints, fractures' },
          { key: 'location', label: 'Where', placeholder: '1st floor, OPD block' },
        ]} />
    </section>
  );
}

export function EmergencySection({ s, set }) {
  const em = s.emergency || {};
  const setEm = (patch) => set({ emergency: { ...em, ...patch } });
  return (
    <section className="card">
      <h2 className="h-card">Emergency, visiting and admissions</h2>
      <div className="form-grid">
        <label className="field">24x7 emergency number<input value={em.phone || ''} onChange={(e) => setEm({ phone: e.target.value })} placeholder="033 4000 1111" /></label>
        <label className="field">Ambulance number<input value={em.ambulancePhone || ''} onChange={(e) => setEm({ ambulancePhone: e.target.value })} placeholder="98300 00000" /></label>
      </div>
      <label className="field">Emergency note (optional)<input value={em.note || ''} onChange={(e) => setEm({ note: e.target.value })} placeholder="Emergency is open 24 hours, 7 days." /></label>
      <label className="field">Visiting hours<textarea rows={2} value={s.visitingHours || ''} onChange={(e) => set({ visitingHours: e.target.value })}
        placeholder="11 AM – 12 noon and 5 PM – 7 PM. One visitor per patient." /></label>
      <label className="field">Admissions<textarea rows={2} value={s.admissionInfo || ''} onChange={(e) => set({ admissionInfo: e.target.value })}
        placeholder="Admission desk, ground floor, 9 AM – 6 PM. Bring photo ID and the doctor's advice." /></label>
      <label className="field">Insurance, TPA and cashless<textarea rows={3} value={s.insuranceInfo || ''} onChange={(e) => set({ insuranceInfo: e.target.value })}
        placeholder="Cashless with Star Health, HDFC Ergo… Visit the TPA desk with your policy card." /></label>
      <p className="muted small">The receptionist gives the emergency numbers on emergency calls, and answers visiting, admission and insurance questions from these.</p>
    </section>
  );
}

export function LabSection({ s, set, HoursEditor }) {
  const lab = s.lab || {};
  const setLab = (patch) => set({ lab: { ...lab, ...patch } });
  return (
    <section className="card">
      <div><h2 className="h-card">Lab tests, scans and health packages</h2>
        <span className="muted small">The receptionist tells callers prices and preparation (like fasting), and can book a lab slot.</span></div>
      <div className="form-grid">
        <label className="field">Lab name<input value={lab.name || ''} onChange={(e) => setLab({ name: e.target.value })} placeholder="Diagnostic Lab" /></label>
        <label className="field">Slot length (minutes)<input type="number" min="5" max="120" value={lab.slotMinutes || 10} onChange={(e) => setLab({ slotMinutes: Number(e.target.value) })} /></label>
        <label className="check"><input type="checkbox" checked={Boolean(lab.bookable)} onChange={(e) => setLab({ bookable: e.target.checked })} /> Receptionist can book lab slots</label>
      </div>
      <label className="field">Where to collect reports<input value={lab.collectInfo || ''} onChange={(e) => setLab({ collectInfo: e.target.value })}
        placeholder="Lab counter, ground floor, 8 AM – 8 PM, with your bill." /></label>
      {lab.bookable && <>
        <label className="check"><input type="checkbox" checked={Boolean(lab.useOwnHours)} onChange={(e) => setLab({ useOwnHours: e.target.checked })} /> Lab has its own hours (otherwise hospital hours)</label>
        {lab.useOwnHours && <HoursEditor idPrefix="lab" value={lab.hours} onChange={(hours) => setLab({ hours })} />}
      </>}
      <h3 className="h-sub">Tests and scans</h3>
      <ListEditor items={lab.tests || []} onChange={(tests) => setLab({ tests })} blank={blankTest} addLabel="+ Add test"
        emptyText="No tests listed."
        fields={[
          { key: 'name', label: 'Test', placeholder: 'Lipid profile', required: true },
          { key: 'price', label: 'Price', placeholder: '₹600' },
          { key: 'prep', label: 'Preparation', placeholder: '12 hours fasting' },
          { key: 'reportTime', label: 'Report in', placeholder: 'same day' },
        ]} />
      <h3 className="h-sub">Health check-up packages</h3>
      <ListEditor items={lab.packages || []} onChange={(packages) => setLab({ packages })} blank={blankPackage} addLabel="+ Add package"
        emptyText="No packages listed."
        fields={[
          { key: 'name', label: 'Package', placeholder: 'Full body check-up', required: true },
          { key: 'price', label: 'Price', placeholder: '₹2499' },
          { key: 'includes', label: 'Includes', placeholder: 'CBC, sugar, lipid, liver, kidney…' },
          { key: 'prep', label: 'Preparation', placeholder: '12 hours fasting' },
        ]} />
    </section>
  );
}

/** Extra per-doctor fields: department, room, covering doctor. */
export function DoctorHospitalFields({ d, i, s, setDoc }) {
  const others = (s.doctors || []).filter((x) => x.name && x.name !== d.name).map((x) => x.name);
  return (
    <div className="form-grid">
      <label className="field">Department
        <input list="dept-list" value={d.department || ''} onChange={(e) => setDoc(i, { department: e.target.value })} placeholder="General Medicine" />
      </label>
      <label className="field">OPD room<input value={d.room || ''} onChange={(e) => setDoc(i, { room: e.target.value })} placeholder="12" /></label>
      <label className="field">Covering doctor on leave days
        <select value={d.substitute || ''} onChange={(e) => setDoc(i, { substitute: e.target.value })}>
          <option value="">None</option>{others.map((n) => <option key={n}>{n}</option>)}
        </select>
      </label>
    </div>
  );
}

export function DepartmentDatalist({ s }) {
  return <datalist id="dept-list">{(s.departments || []).map((d) => <option key={d.name} value={d.name} />)}</datalist>;
}
