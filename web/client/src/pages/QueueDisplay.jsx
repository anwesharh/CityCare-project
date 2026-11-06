// Public waiting-room screen: big "now serving" tokens. Open /queue on a TV and press F11.
import { useEffect, useState } from 'react';

export default function QueueDisplay() {
  const [q, setQ] = useState(null);
  const [now, setNow] = useState(new Date());
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const load = () => fetch('/api/queue').then((r) => r.json()).then((d) => { setQ(d); setOffline(false); }).catch(() => setOffline(true));
    load();
    const a = setInterval(load, 5000);
    const b = setInterval(() => setNow(new Date()), 15000);
    return () => { clearInterval(a); clearInterval(b); };
  }, []);
  const items = (q?.items || []).filter((i) => !i.onLeave);
  return (
    <div className="qd">
      <header className="qd-head">
        <strong>{q?.clinicName || 'OPD'}</strong>
        <span>{now.toLocaleString('en-IN', { weekday: 'long', hour: 'numeric', minute: '2-digit' })}</span>
      </header>
      {offline && <p className="qd-offline">Reconnecting…</p>}
      <main className="qd-grid" aria-live="polite">
        {items.map((i) => (
          <div key={i.doctor} className="qd-card">
            <div className="qd-doc">{i.doctor}</div>
            <div className="qd-meta">{[i.department || i.specialty, i.room && `Room ${i.room}`].filter(Boolean).join(' · ')}</div>
            <div className="qd-label">Now serving</div>
            <div className="qd-token">{i.nowServing || '—'}</div>
            {i.waiting !== null && <div className="qd-meta">{i.waiting} waiting</div>}
          </div>
        ))}
        {q && items.length === 0 && <p className="qd-meta">No OPD running right now.</p>}
      </main>
      <footer className="qd-foot">Please wait for your token number · टोकन नंबर का इंतज़ार करें · আপনার টোকেন নম্বরের জন্য অপেক্ষা করুন</footer>
    </div>
  );
}
