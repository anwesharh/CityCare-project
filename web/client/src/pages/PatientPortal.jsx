import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Badge } from '../components/AdminLayout.jsx';
import SiteHeader from '../components/SiteHeader.jsx';
import { MicIcon } from '../components/Icons.jsx';
import { PrescriptionCard, UploadPrescription } from '../components/Prescriptions.jsx';
import { fmtDate, fmtTime, openFile, patientApi, patientAuth, todayIST } from '../api.js';

const REPORT = { processing: ['Being processed', 'warn'], ready: ['Ready', 'ok'], collected: ['Collected', 'muted'] };

/** Medicines to take today, from prescriptions whose course is still running. */
function todaysDoses(prescriptions) {
  const today = todayIST();
  const doses = [];
  for (const rx of prescriptions) {
    if (rx.status !== 'done') continue;
    const start = rx.date || String(rx.createdAt).slice(0, 10);
    for (const m of rx.medicines || []) {
      if (!m.reminders || !m.times?.length) continue;
      const days = m.durationDays || 30;
      const end = new Date(new Date(`${start}T00:00:00+05:30`).getTime() + days * 86400000).toISOString().slice(0, 10);
      if (today < start || today >= end) continue;
      for (const t of m.times) doses.push({ time: t, name: `${m.name}${m.strength ? ` ${m.strength}` : ''}`, how: [m.dose, m.timing].filter(Boolean).join(', ') });
    }
  }
  return doses.sort((a, b) => a.time.localeCompare(b.time));
}

const nowHHMM = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }).format(new Date());

/** Pop-up reminders while this page is open (for reminders when it's closed, use "Add to phone calendar"). */
function useDoseNotifications(doses, enabled) {
  const timers = useRef([]);
  useEffect(() => {
    timers.current.forEach(clearTimeout); timers.current = [];
    if (!enabled || typeof Notification === 'undefined' || Notification.permission !== 'granted') return undefined;
    const now = nowHHMM();
    for (const d of doses) {
      if (d.time <= now) continue;
      const [h, m] = d.time.split(':').map(Number);
      const [nh, nm] = now.split(':').map(Number);
      const ms = ((h * 60 + m) - (nh * 60 + nm)) * 60000;
      timers.current.push(setTimeout(() => new Notification(`Time to take ${d.name}`, { body: d.how || 'Medicine reminder' }), ms));
    }
    return () => timers.current.forEach(clearTimeout);
  }, [doses, enabled]);
}

export default function PatientPortal() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notify, setNotify] = useState(typeof Notification !== 'undefined' && Notification.permission === 'granted');
  const load = () => patientApi('/me').then(setData).catch((e) => setError(e.message));

  useEffect(() => { if (patientAuth.token) { load(); const t = setInterval(load, 60000); return () => clearInterval(t); } return undefined; }, []);

  const doses = useMemo(() => (data ? todaysDoses(data.prescriptions) : []), [data]);
  useDoseNotifications(doses, notify);

  if (!patientAuth.token) return <Navigate to="/patient/login" replace />;
  const logout = () => { patientAuth.clear(); navigate('/patient/login'); };
  const now = nowHHMM();

  async function enableNotifications() {
    if (typeof Notification === 'undefined') { setError('This browser does not support notifications. Use "Add reminders to phone calendar" instead.'); return; }
    setNotify((await Notification.requestPermission()) === 'granted');
  }

  return (
    <div className="portal">
      <SiteHeader />

      <main className="container section stack">
        <div className="row-between wrap">
          <div><h1 className="h-page">Hello{data?.patient?.name ? `, ${data.patient.name}` : ''}</h1>
            <span className="muted">Your appointments, reports and medicines{data?.patient?.phone ? ` · ${data.patient.phone}` : ''}</span></div>
          <div className="row gap wrap">
            <Link to="/talk" className="btn btn-primary btn-pill"><MicIcon /> Talk to our receptionist</Link>
            <button type="button" className="btn btn-pill" onClick={logout}>Log out</button>
          </div>
        </div>
        {error && <p className="error-note" role="alert">{error}</p>}
        {!data && !error && <p className="muted">Loading…</p>}

        {data && <>
          <section className="card" aria-labelledby="today-h">
            <div className="row-between wrap"><h2 id="today-h" className="h-card">Today's medicines</h2>
              {doses.length > 0 && !notify && <button type="button" className="btn btn-small" onClick={enableNotifications}>Remind me on this device</button>}
              {notify && doses.length > 0 && <span className="muted small">Pop-up reminders are on while this page is open</span>}</div>
            {doses.length === 0 ? <p className="muted">No reminders for today. Add a prescription below and turn on reminders.</p> : (
              <ul className="dose-list">
                {doses.map((d, i) => (
                  <li key={i} className={d.time <= now ? 'dose past' : 'dose'}>
                    <span className="dose-time">{d.time}</span><span><strong>{d.name}</strong>{d.how && <span className="muted small"> · {d.how}</span>}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-labelledby="appt-h">
            <div className="row-between wrap"><h2 id="appt-h" className="h-card">Appointments</h2>
              <Link to="/talk" className="link-strong small">Book, cancel or reschedule →</Link></div>
            {data.calendarError && <p className="muted">{data.calendarError}</p>}
            {data.upcoming.length === 0 && !data.calendarError && <p className="muted">No upcoming appointments. <Link to="/talk" className="link-strong">Talk to our receptionist</Link> to book one. Give the same mobile number so it shows here.</p>}
            <div className="card-grid">
              {data.upcoming.map((a) => (
                <div key={a.id} className="appt-card">
                  <div className="row-between"><strong>{fmtDate(a.start)}, {fmtTime(a.start)}</strong>{a.token && <span className="token">#{a.token}</span>}</div>
                  <span>{a.doctor || 'Doctor'}{a.queue?.room ? ` · Room ${a.queue.room}` : ''}</span>
                  {a.queue && (a.queue.done
                    ? <Badge kind="ok">Your turn has come</Badge>
                    : <span className="queue-live">Now serving <strong>{a.queue.nowServing || '—'}</strong> · {a.queue.ahead} {a.queue.ahead === 1 ? 'patient' : 'patients'} ahead of you</span>)}
                </div>
              ))}
            </div>
            {data.past.length > 0 && (
              <details><summary className="link-strong small">Past visits ({data.past.length})</summary>
                <ul className="plain-list">{data.past.map((a) => <li key={a.id}>{fmtDate(a.start)} · {a.doctor || 'Doctor'}</li>)}</ul>
              </details>
            )}
          </section>

          <section className="card" aria-labelledby="rep-h">
            <h2 id="rep-h" className="h-card">Lab reports</h2>
            {data.reports.length === 0 && <p className="muted">No reports yet.</p>}
            <div className="table-wrap">
              {data.reports.length > 0 && (
                <table className="table rx-table">
                  <thead><tr><th>Test</th><th>Date</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>{data.reports.map((r) => (
                    <tr key={r._id}>
                      <td><strong>{r.test}</strong>{r.reportNo ? <span className="muted small"> · #{r.reportNo}</span> : null}</td>
                      <td className="small">{fmtDate(r.createdAt)}{r.status === 'processing' && r.expectedOn ? <><br /><span className="muted">Expected {fmtDate(`${r.expectedOn}T12:00:00+05:30`)}</span></> : null}</td>
                      <td><Badge kind={REPORT[r.status][1]}>{REPORT[r.status][0]}</Badge></td>
                      <td className="actions">{r.file
                        ? <button type="button" className="btn btn-small btn-primary" onClick={() => openFile(`/patient/reports/${r._id}/file`, 'patient').catch((e) => setError(e.message))}>View report</button>
                        : r.status !== 'processing' && <span className="muted small">Collect at the lab</span>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </div>
            {data.clinic.collectInfo && <p className="muted small">{data.clinic.collectInfo}</p>}
          </section>

          <section className="card" aria-labelledby="rx-h">
            <div className="row-between wrap"><h2 id="rx-h" className="h-card">My prescriptions</h2>
              <UploadPrescription who="patient" onAdded={(rx) => setData((d) => ({ ...d, prescriptions: [rx, ...d.prescriptions] }))} /></div>
            <p className="muted small">Medicines are read automatically from the photo. Always check them against your prescription and follow your doctor's advice.</p>
            {data.prescriptions.length === 0 && <p className="muted">No prescriptions saved yet.</p>}
            {data.prescriptions.map((rx) => (
              <PrescriptionCard key={rx._id} rx={rx} who="patient" canDelete={rx.source !== 'staff'}
                onDeleted={(id) => setData((d) => ({ ...d, prescriptions: d.prescriptions.filter((x) => x._id !== id) }))} />
            ))}
          </section>
        </>}
      </main>
    </div>
  );
}
