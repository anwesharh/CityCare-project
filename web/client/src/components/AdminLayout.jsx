import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, NavLink, useNavigate } from 'react-router-dom';
import { api, auth } from '../api.js';
import { Logo } from './Icons.jsx';
import { useClinic } from '../hooks/useClinic.js';

export function RequireAuth({ children, roles }) {
  const user = auth.user;
  if (!auth.token || !user) return <Navigate to="/admin/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/admin" replace />;
  return children;
}

const NOT_LAB = ['admin', 'staff', 'doctor'];
const NAV = [
  { to: '/admin', label: 'Dashboard', end: true },
  { to: '/admin/appointments', label: 'Appointments' },
  { to: '/admin/opd', label: 'OPD queue & beds' },
  { to: '/admin/reports', label: 'Lab reports', roles: ['admin', 'staff', 'lab'] },
  { to: '/admin/patients', label: 'Patients', roles: NOT_LAB },
  { to: '/admin/calls', label: 'Calls & transcripts', roles: NOT_LAB },
  { to: '/admin/live', label: 'Live calls', roles: ['admin', 'staff'] },
  { to: '/admin/messages', label: 'Messages', roles: NOT_LAB },
  { to: '/admin/analytics', label: 'Analytics', roles: ['admin', 'staff'] },
  { to: '/admin/settings', label: 'Settings', roles: ['admin'] },
  { to: '/admin/staff', label: 'Staff accounts', roles: ['admin'] },
  { to: '/admin/account', label: 'My account' },
];

export default function AdminLayout({ children }) {
  const navigate = useNavigate();
  const clinic = useClinic();
  const user = auth.user || {};
  const logout = () => { auth.clear(); navigate('/admin/login'); };
  const cls = ({ isActive }) => `side-link${isActive ? ' active' : ''}`;
  return (
    <div className="admin">
      <nav aria-label="Admin" className="sidebar">
        <div className="side-brand"><Logo size={30} fill="#14897F" /><span>{clinic.clinicName}</span></div>
        {NAV.filter((n) => !n.roles || n.roles.includes(user.role)).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={cls}>{n.label}</NavLink>
        ))}
        <a href="/" className="side-link">View website</a>
        <div className="side-user">
          <span>{user.name || user.email}</span>
          <span className="side-role">{user.role === 'doctor' ? `Doctor · ${user.doctorName || ''}` : user.role === 'lab' ? 'Lab staff' : user.role}</span>
        </div>
        <button type="button" className="side-link side-logout" onClick={logout}>Log out</button>
      </nav>
      <main className="admin-main">{user.role !== 'lab' && <EmergencyAlerts canWatch={['admin', 'staff'].includes(user.role)} />}{children}</main>
    </div>
  );
}

export function Badge({ kind = 'ok', children }) {
  return <span className={`badge badge-${kind}`}>{children}</span>;
}

export function ErrorNote({ error }) {
  return error ? <p className="error-note" role="alert">{error}</p> : null;
}

/** Two short beeps, so the front desk notices an emergency call. */
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.35].forEach((t) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.25, ctx.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.3);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.3);
    });
  } catch { /* audio blocked until the page is clicked once */ }
}

const seenAlerts = new Set();

/** Red banner for emergency calls in the last 24 h that nobody has acknowledged yet. */
function EmergencyAlerts({ canWatch }) {
  const [alerts, setAlerts] = useState([]);
  const first = useRef(true);
  useEffect(() => {
    let alive = true;
    const load = () => api('/admin/alerts?open=1').then(({ alerts: list }) => {
      if (!alive) return;
      const fresh = list.filter((a) => !seenAlerts.has(a._id));
      fresh.forEach((a) => seenAlerts.add(a._id));
      if (fresh.length && !first.current) beep();
      first.current = false;
      setAlerts(list);
    }).catch(() => {});
    load();
    const t = setInterval(load, 10000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  async function ack(a) {
    await api(`/admin/alerts/${a._id}/ack`, { method: 'POST' }).catch(() => {});
    setAlerts((list) => list.filter((x) => x._id !== a._id));
  }
  if (!alerts.length) return null;
  return (
    <div className="alert-stack" role="alert">
      {alerts.map((a) => (
        <div key={a._id} className="alert-bar">
          <div>
            <strong>Emergency call · {new Date(a.at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</strong>
            <span>{a.symptoms || (a.keywords || []).join(', ') || 'Emergency symptoms mentioned'}</span>
            <span className="small">{[a.callerName, a.callerPhone].filter(Boolean).join(' · ') || 'Caller details not given yet'}</span>
          </div>
          <div className="row gap">
            {canWatch && <Link to="/admin/live" className="btn btn-small btn-light">Live calls</Link>}
            <button type="button" className="btn btn-small btn-light" onClick={() => ack(a)}>Acknowledge</button>
          </div>
        </div>
      ))}
    </div>
  );
}
