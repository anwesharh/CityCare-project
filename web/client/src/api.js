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

// ---------------- patient portal ----------------
const PKEY = 'citycare_patient';
export const patientAuth = {
  get token() { try { return localStorage.getItem(PKEY); } catch { return null; } },
  set(token) { try { localStorage.setItem(PKEY, token); } catch { /* private mode */ } },
  clear() { try { localStorage.removeItem(PKEY); } catch { /* ignore */ } },
};

const tokenFor = (who) => (who === 'patient' ? patientAuth.token : auth.token);

function onUnauthorized(who) {
  if (who === 'patient') { patientAuth.clear(); window.location.assign('/patient/login'); }
  else { auth.clear(); window.location.assign('/admin/login'); }
}

export async function patientApi(path, { method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (patientAuth.token) headers.authorization = `Bearer ${patientAuth.token}`;
  const res = await fetch(`/api/patient${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && patientAuth.token) onUnauthorized('patient');
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** Upload one file (field "file") to /api{path}. who: 'staff' | 'patient'. */
/** Photos from phones are often 3–8 MB: resize to max 2000 px as JPEG so uploads are fast and fit the server limit. */
async function shrinkImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1.5 * 1024 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch { return file; }
}

export async function uploadFile(path, original, who = 'staff') {
  const file = await shrinkImage(original);
  const fd = new FormData();
  fd.append('file', file);
  const t = tokenFor(who);
  const res = await fetch(`/api${path}`, { method: 'POST', headers: t ? { authorization: `Bearer ${t}` } : {}, body: fd });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) onUnauthorized(who);
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data;
}

/** Open a protected file (PDF/photo) in a new tab, or download it (download=true). */
export async function openFile(path, who = 'staff', { download = false, filename } = {}) {
  const win = download ? null : window.open('', '_blank');
  try {
    const t = tokenFor(who);
    const res = await fetch(`/api${path}`, { headers: t ? { authorization: `Bearer ${t}` } : {} });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Could not open the file'); }
    const url = URL.createObjectURL(await res.blob());
    if (download) {
      Object.assign(document.createElement('a'), { href: url, download: filename || 'file' }).click();
    } else if (win) { win.location.href = url; } else { window.location.assign(url); }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { if (win) win.close(); throw e; }
}
