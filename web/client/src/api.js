// src/api.js — tiny fetch wrapper; staff login token kept in localStorage
const KEY = 'citycare_token';

export const auth = {
  get token() { try { return localStorage.getItem(KEY); } catch { return null; } },
  /** Logged-in user's info from the token: { email, name, role, doctorName } */
  get user() {
    try {
      const t = this.token; if (!t) return null;
      const b64 = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(b64))));
    } catch { return null; }
  },
  set(token) { try { localStorage.setItem(KEY, token); } catch { /* private mode */ } },
  clear() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } },
};

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path.startsWith('/admin')) {
    auth.clear();
    window.location.assign('/admin/login');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const fmt = (opts) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', ...opts });
export const fmtTime = (d) => (d ? fmt({ hour: 'numeric', minute: '2-digit' }).format(new Date(d)) : '');
export const fmtDate = (d) => (d ? fmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(d)) : '');
export const fmtDateTime = (d) => (d ? `${fmtDate(d)}, ${fmtTime(d)}` : '');
export const fmtDuration = (s) => (s == null ? '' : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);
export const todayIST = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
