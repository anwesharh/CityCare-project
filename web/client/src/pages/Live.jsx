import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import AdminLayout, { ErrorNote } from '../components/AdminLayout.jsx';
import { api, fmtTime } from '../api.js';

export default function Live() {
  const [calls, setCalls] = useState([]);
  const [error, setError] = useState('');
  const [watching, setWatching] = useState(null);
  const [lines, setLines] = useState([]);
  const [listen, setListen] = useState(false);
  const roomRef = useRef(null);
  const audioRef = useRef(null);

  useEffect(() => {
    let alive = true;
    const load = () => api('/admin/live').then((d) => alive && setCalls(d.calls)).catch((e) => alive && setError(e.message));
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); roomRef.current?.disconnect(); };
  }, []);

  useEffect(() => {
    audioRef.current?.querySelectorAll('audio').forEach((a) => { a.muted = !listen; });
  }, [listen]);

  async function watch(room) {
    await roomRef.current?.disconnect();
    setLines([]); setWatching(room); setError('');
    try {
      const { token, url } = await api(`/admin/live/${room}/watch`, { method: 'POST' });
      const r = new Room();
      roomRef.current = r;
      r.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio && audioRef.current) {
          const el = track.attach(); el.muted = !listen; audioRef.current.appendChild(el);
        }
      });
      r.on(RoomEvent.Disconnected, () => setWatching((w) => (w === room ? null : w)));
      r.registerTextStreamHandler('lk.transcription', async (reader, who) => {
        const isAgent = String(who.identity).startsWith('agent');
        const id = reader.info.attributes?.['lk.segment_id'] || reader.info.id;
        let text = '';
        for await (const chunk of reader) {
          text += chunk;
          setLines((prev) => {
            const i = prev.findIndex((l) => l.id === id);
            const line = { id, who: isAgent ? 'Receptionist' : 'Caller', text };
            if (i === -1) return [...prev, line];
            const next = prev.slice(); next[i] = line; return next;
          });
        }
      });
      r.registerTextStreamHandler('lk.chat', async (reader) => {
        const text = await reader.readAll();
        setLines((prev) => [...prev, { id: reader.info.id, who: 'Caller (typed)', text }]);
      });
      await r.connect(url, token);
      await r.startAudio();
    } catch (e) { setError(e.message); setWatching(null); }
  }

  async function stop() { await roomRef.current?.disconnect(); roomRef.current = null; setWatching(null); }

  return (
    <AdminLayout>
      <div><h1 className="h-page">Live calls</h1><span className="muted">Follow calls as they happen. You join silently: the caller can't hear or see you.</span></div>
      <ErrorNote error={error} />
      <div className="split">
        <section className="card grow-2">
          <h2 className="h-card">Happening now</h2>
          {calls.length === 0 && <p className="muted">No calls right now. This list refreshes every 5 seconds.</p>}
          {calls.map((c) => (
            <div key={c.room} className="msg">
              <div className="row-between small">
                <strong>{c.caller || 'Caller'}</strong>
                <span className="muted">{c.channel === 'web' ? 'Website' : 'Phone'}{c.startedAt ? ` · since ${fmtTime(c.startedAt)}` : ''}</span>
              </div>
              {watching === c.room
                ? <button type="button" className="btn btn-small" onClick={stop}>Stop watching</button>
                : <button type="button" className="btn btn-small btn-primary" onClick={() => watch(c.room)}>Watch</button>}
            </div>
          ))}
        </section>
        <section className="card grow-3" aria-live="polite">
          <div className="row-between">
            <h2 className="h-card">Live transcript</h2>
            {watching && <label className="check"><input type="checkbox" checked={listen} onChange={(e) => setListen(e.target.checked)} /> Play audio</label>}
          </div>
          {!watching && <p className="muted">Pick a call to watch.</p>}
          {watching && lines.length === 0 && <p className="muted">Waiting for someone to speak…</p>}
          {lines.map((l) => (
            <div key={l.id} className="t-line"><div><span className={`t-who ${l.who === 'Receptionist' ? 't-assistant' : 't-user'}`}>{l.who}</span><p>{l.text}</p></div></div>
          ))}
          <div ref={audioRef} hidden />
        </section>
      </div>
    </AdminLayout>
  );
}
