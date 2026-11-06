import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import AdminLayout, { Badge, ErrorNote } from '../components/AdminLayout.jsx';
import { api, fmtDateTime, fmtDuration } from '../api.js';

const END_REASON = {
  caller_goodbye: 'Receptionist ended it after the caller said goodbye',
  silence_timeout: 'Caller was silent too long',
  max_duration_reached: 'Hit the maximum call length (voice.idle.max_call_duration_seconds)',
  unproductive_turns_exhausted: 'Receptionist got stuck repeating itself',
};

function offset(at, start) {
  if (!at || !start) return '';
  const s = Math.max(0, Math.round((new Date(at) - new Date(start)) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function download(call) {
  const text = (call.transcript || []).filter((l) => l.role !== 'tool')
    .map((l) => `${l.role === 'user' ? 'Caller' : 'Receptionist'}: ${l.text}`).join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `call-${call.callId}.txt` });
  a.click();
  URL.revokeObjectURL(url);
}

export default function CallDetail() {
  const { id } = useParams();
  const [call, setCall] = useState(null);
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api(`/admin/calls/${id}`).then((d) => { setCall(d.call); setMessages(d.messages); }).catch((e) => setError(e.message));
  }, [id]);

  async function toggleFollowUp() {
    const { call: c } = await api(`/admin/calls/${id}`, { method: 'PATCH', body: { followedUp: !call.followedUp } });
    setCall((prev) => ({ ...prev, followedUp: c.followedUp }));
  }

  if (!call) return <AdminLayout><ErrorNote error={error} />{!error && <p className="muted">Loading…</p>}</AdminLayout>;
  const report = call.emergencyReports?.[0];

  return (
    <AdminLayout>
      <Link to="/admin/calls" className="link-strong small">← All calls</Link>
      <div className="row-between wrap">
        <div>
          <div className="row gap">
            <h1 className="h-page">Call · {fmtDateTime(call.startedAt)}</h1>
            {call.urgent && <Badge kind="danger">Urgent</Badge>}
            {call.followedUp && <Badge kind="ok">Followed up</Badge>}
          </div>
          <span className="muted">{call.channel === 'phone' ? 'Phone call' : 'Website call'} · {fmtDuration(call.durationSeconds)}
            {call.languages?.length ? ` · ${call.languages.join(', ')}` : ''}</span>
        </div>
        <div className="row gap">
          <button type="button" className="btn btn-pill" onClick={() => download(call)}>Download transcript</button>
          <button type="button" className="btn btn-primary btn-pill" onClick={toggleFollowUp}>
            {call.followedUp ? 'Mark as not followed up' : 'Mark as followed up'}
          </button>
        </div>
      </div>

      <div className="split">
        <div className="grow-2 stack">
          <section className="card">
            <h2 className="h-card">AI summary</h2>
            <p>{call.summary || 'Summary not available (add GOOGLE_API_KEY to server/.env to enable).'}</p>
          </section>
          <section className="card">
            <h2 className="h-card">Details</h2>
            <dl className="details">
              <dt>Caller</dt><dd>{call.callerName || '—'}</dd>
              <dt>Callback</dt><dd>{call.callerPhone || '—'}</dd>
              <dt>Outcome</dt><dd>{(call.outcomes || []).join(', ') || '—'}</dd>
              <dt>How it ended</dt><dd>{call.endReason ? (END_REASON[call.endReason] || call.endReason) : 'Caller hung up'}</dd>
              {call.urgent && <><dt>Emergency</dt><dd>{report?.symptoms || call.urgentKeywords?.join(', ')}</dd></>}
              <dt>Appointment</dt><dd>{call.appointment?.start_iso ? fmtDateTime(call.appointment.start_iso) : 'None booked'}</dd>
            </dl>
          </section>
          {messages.length > 0 && (
            <section className="card">
              <h2 className="h-card">Messages taken</h2>
              {messages.map((m) => <div key={m._id} className="msg"><strong>{m.callerName}</strong><p>{m.text}</p><span className="muted small">{m.callbackNumber}</span></div>)}
            </section>
          )}
        </div>

        <section aria-label="Transcript" className="card grow-3">
          <h2 className="h-card">Transcript</h2>
          {(call.transcript || []).length === 0 && <p className="muted">No transcript recorded.</p>}
          {(call.transcript || []).map((l, i) => (
            <div key={i} className="t-line">
              <span className="t-time">{offset(l.at, call.startedAt)}</span>
              <div>
                <span className={`t-who t-${l.role}`}>{l.role === 'user' ? 'Caller' : l.role === 'assistant' ? 'Receptionist' : `Action · ${l.text}`}</span>
                {l.role !== 'tool' && <p>{l.text}</p>}
              </div>
            </div>
          ))}
        </section>
      </div>
    </AdminLayout>
  );
}
