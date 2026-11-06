import { useEffect, useState } from 'react';
import AdminLayout, { ErrorNote } from '../components/AdminLayout.jsx';
import { BarChart, BarList } from '../components/Charts.jsx';
import { api } from '../api.js';

const OUTCOME = {
  appointment_booked: 'Booked', appointment_cancelled: 'Cancelled', appointment_rescheduled: 'Rescheduled',
  message_taken: 'Message taken', transferred: 'Transferred', hung_up: 'Caller hung up',
  agent_ended: 'Completed', intake_submitted: 'Intake',
};
const LANG = { en: 'English', hi: 'Hindi', bn: 'Bengali', 'en-IN': 'English', 'hi-IN': 'Hindi', 'bn-IN': 'Bengali' };
const hourLabel = (h) => `${((h + 11) % 12) + 1}${h < 12 ? 'a' : 'p'}`;
const shortDate = (ymd) => new Date(`${ymd}T12:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

export default function Analytics() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setData(null);
    api(`/admin/analytics?days=${days}`).then(setData).catch((e) => setError(e.message));
  }, [days]);

  const t = data?.totals;
  return (
    <AdminLayout>
      <div className="row-between wrap">
        <div><h1 className="h-page">Analytics</h1><span className="muted">How the receptionist is doing</span></div>
        <div role="group" aria-label="Time range" className="row gap">
          {[7, 30, 90].map((d) => (
            <button key={d} type="button" className={`btn btn-pill ${days === d ? 'btn-primary' : ''}`} onClick={() => setDays(d)} aria-pressed={days === d}>
              Last {d} days
            </button>
          ))}
        </div>
      </div>
      <ErrorNote error={error} />
      {!data && !error && <p className="muted">Loading…</p>}
      {data && (
        <>
          <div className="stat-grid">
            <div className="card stat"><span>Calls</span><strong>{t.calls}</strong></div>
            <div className="card stat"><span>Booking rate</span><strong>{t.bookingRate}%</strong></div>
            <div className="card stat"><span>Avg call length</span><strong>{Math.floor(t.avgDurationSeconds / 60)}:{String(t.avgDurationSeconds % 60).padStart(2, '0')}</strong></div>
            <div className="card stat"><span>Urgent calls</span><strong>{t.urgent}</strong></div>
          </div>

          <section className="card">
            <h2 className="h-card">Calls per day</h2>
            <BarChart title="Day" data={data.perDay.map((d) => ({ label: shortDate(d.date), tip: shortDate(d.date), value: d.calls }))}
              labelEvery={days > 30 ? 10 : days > 7 ? 5 : 1} />
          </section>

          <div className="split">
            <section className="card grow-3">
              <h2 className="h-card">Busiest hours</h2>
              <BarChart title="Hour" height={200} labelEvery={3}
                data={data.perHour.map((h) => ({ label: hourLabel(h.hour), tip: `${hourLabel(h.hour)}m – ${hourLabel((h.hour + 1) % 24)}m`, value: h.calls }))} />
            </section>
            <section className="card grow-2">
              <h2 className="h-card">What happened on calls</h2>
              <BarList items={data.outcomes.map((o) => ({ label: OUTCOME[o.outcome] || o.outcome, value: o.n }))} />
            </section>
          </div>

          <div className="split">
            <section className="card grow-2">
              <h2 className="h-card">Appointments by doctor</h2>
              <BarList items={data.appointmentsByDoctor.map((d) => ({ label: d.doctor, value: d.n }))} empty="No appointments in this period." />
            </section>
            <section className="card grow-2">
              <h2 className="h-card">Languages</h2>
              <BarList items={data.languages.map((l) => ({ label: LANG[l.language] || l.language, value: l.n }))} empty="No language data yet." />
            </section>
            <section className="card grow-2">
              <h2 className="h-card">Most asked questions</h2>
              <BarList items={data.topQuestions.map((q) => ({ label: q.question, value: q.n }))} empty="No FAQ answers yet." />
            </section>
          </div>
        </>
      )}
    </AdminLayout>
  );
}
