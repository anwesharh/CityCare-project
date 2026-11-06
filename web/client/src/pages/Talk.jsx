import { useEffect, useRef, useState } from 'react';
import SiteHeader from '../components/SiteHeader.jsx';
import { HangUpIcon, MicIcon, MicOffIcon, WaveIcon } from '../components/Icons.jsx';
import { useVoiceCall } from '../hooks/useVoiceCall.js';
import { useClinic } from '../hooks/useClinic.js';

const STATE_TEXT = {
  waiting: 'Connecting you to the receptionist…',
  initializing: 'Receptionist is getting ready…',
  listening: 'Listening — go ahead and speak',
  thinking: 'Thinking…',
  speaking: 'Receptionist is speaking…',
};

const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

export default function Talk() {
  const call = useVoiceCall();
  const clinic = useClinic();
  const listRef = useRef(null);
  const live = call.status === 'connected' || call.status === 'connecting';
  const [draft, setDraft] = useState('');

  async function send(e) {
    e.preventDefault();
    if (await call.sendMessage(draft)) setDraft('');
  }

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [call.lines]);

  return (
    <div className="page">
      <SiteHeader minimal />
      <main className="container talk-grid">
        <section aria-label="Call controls" className="call-panel">
          <span className="call-pill">
            {call.status === 'connected' ? `● Connected · ${mmss(call.seconds)}`
              : call.status === 'connecting' ? 'Connecting…'
                : call.status === 'ended' ? 'Call ended' : 'Ready'}
          </span>
          <div className={`call-orb orb-${call.status === 'connected' ? call.agentState : 'idle'}`}>
            <WaveIcon size={72} />
          </div>
          <div className="call-state" aria-live="polite">
            <strong>{live ? STATE_TEXT[call.agentState] || 'Connected' : call.status === 'ended' ? 'Thanks for calling' : `Talk to ${clinic.clinicName}`}</strong>
            <span>{live ? (call.muted ? 'Microphone off: type your message on the right' : 'Speak or type. You can interrupt anytime.')
              : 'Uses your microphone. Calls may be recorded for quality. No medical advice is given.'}</span>
          </div>

          {live ? (
            <div className="call-actions">
              <button type="button" className="round-btn" onClick={call.toggleMute}
                aria-label={call.muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={call.muted}>
                {call.muted ? <MicOffIcon size={26} /> : <MicIcon size={26} />}
              </button>
              <button type="button" className="btn btn-danger btn-pill btn-lg" onClick={call.end}>
                <HangUpIcon /> End call
              </button>
            </div>
          ) : (
            <div className="call-actions">
              <button type="button" className="btn btn-light btn-pill btn-lg" onClick={() => call.start({ mic: true })}>
                <MicIcon /> {call.status === 'ended' ? 'Call again' : 'Start call'}
              </button>
              <button type="button" className="btn btn-ghost-light btn-pill btn-lg" onClick={() => call.start({ mic: false })}>
                Type instead
              </button>
            </div>
          )}
          {call.error && <p className="call-error" role="alert">{call.error}</p>}
          <p className="call-languages">Languages: {clinic.languages}</p>
          <div ref={call.audioRef} hidden />
        </section>

        <section aria-label="Live transcript" className="card transcript-card">
          <div className="row-between">
            <h1 className="h-card">Live transcript</h1>
            {call.status === 'connected' && <span className="muted small">Updates as you talk</span>}
          </div>
          <div ref={listRef} className="bubbles" aria-live="polite">
            {call.lines.length === 0 && (
              <p className="muted empty">{live ? 'The conversation will appear here.' : 'Press "Start call" to talk, or "Type instead" to chat.'}</p>
            )}
            {call.lines.map((l) => (
              <div key={l.id} className={`bubble ${l.who === 'you' ? 'bubble-you' : 'bubble-agent'}`}>{l.text}</div>
            ))}
          </div>
          <form className="chat-form" onSubmit={send}>
            <label htmlFor="chat-input" className="sr-only">Type a message</label>
            <input id="chat-input" type="text" autoComplete="off" maxLength={500}
              placeholder={call.status === 'connected' ? 'Type a message…' : 'Start a call to type or talk'}
              disabled={call.status !== 'connected'} value={draft} onChange={(e) => setDraft(e.target.value)} />
            <button type="submit" className="btn btn-primary" disabled={call.status !== 'connected' || !draft.trim()}>Send</button>
          </form>
          <div className="try-row">
            <span className="muted small">Try saying:</span>
            <span className="chip">"What are your fees?"</span>
            <span className="chip">"Book me for tomorrow evening"</span>
            <span className="chip">"Cancel my appointment"</span>
            <span className="chip">"Move it to Friday"</span>
          </div>
        </section>
      </main>
    </div>
  );
}
