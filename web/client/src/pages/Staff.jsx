import { useEffect, useState } from 'react';
import AdminLayout, { Badge, ErrorNote } from '../components/AdminLayout.jsx';
import { api, auth } from '../api.js';

const ROLE_HELP = {
  admin: 'Everything, including settings and staff accounts',
  staff: 'Front desk: appointments, calls, messages, patients, analytics',
  doctor: "Only their own appointments, patients and OPD queue",
  lab: 'Lab desk: lab reports, lab bookings and the lab queue',
};

export default function Staff() {
  const [users, setUsers] = useState([]);
  const [doctors, setDoctors] = useState([]);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'staff', doctorName: '' });
  const [error, setError] = useState('');
  const me = auth.user;

  const load = () => api('/admin/users').then((d) => setUsers(d.users)).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    api('/admin/settings').then((d) => setDoctors((d.settings.doctors || []).map((x) => x.name))).catch(() => {});
  }, []);

  async function add(e) {
    e.preventDefault(); setError('');
    try { await api('/admin/users', { method: 'POST', body: form }); setForm({ name: '', email: '', password: '', role: 'staff', doctorName: '' }); load(); }
    catch (err) { setError(err.message); }
  }
  async function update(u, patch) {
    try { await api(`/admin/users/${u.id}`, { method: 'PATCH', body: patch }); load(); } catch (err) { setError(err.message); }
  }
  async function remove(u) {
    if (!window.confirm(`Delete ${u.email}'s account?`)) return;
    try { await api(`/admin/users/${u.id}`, { method: 'DELETE' }); load(); } catch (err) { setError(err.message); }
  }
  async function resetPassword(u) {
    const pw = window.prompt(`New password for ${u.email} (at least 8 characters):`);
    if (pw) update(u, { password: pw });
  }

  return (
    <AdminLayout>
      <div><h1 className="h-page">Staff accounts</h1><span className="muted">Who can log in to this panel</span></div>
      <ErrorNote error={error} />
      <section className="card table-wrap">
        <table className="table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td><strong>{u.name}</strong>{u.email === me?.email && <span className="muted small"> (you)</span>}</td>
                <td>{u.email}</td>
                <td>{u.role === 'doctor' ? `Doctor · ${u.doctorName || '?'}` : u.role === 'lab' ? 'Lab staff' : u.role[0].toUpperCase() + u.role.slice(1)}</td>
                <td>{u.active ? <Badge kind="ok">Active</Badge> : <Badge kind="warn">Disabled</Badge>}</td>
                <td className="actions">
                  <button type="button" className="btn btn-small" onClick={() => resetPassword(u)}>Reset password</button>
                  {u.email !== me?.email && <>
                    <button type="button" className="btn btn-small" onClick={() => update(u, { active: !u.active })}>{u.active ? 'Disable' : 'Enable'}</button>
                    <button type="button" className="btn btn-small btn-danger-outline" onClick={() => remove(u)}>Delete</button>
                  </>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <form className="card" onSubmit={add}>
        <h2 className="h-card">Add a staff member</h2>
        <div className="form-grid">
          <label className="field">Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
          <label className="field">Email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></label>
          <label className="field">Temporary password<input type="text" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required /></label>
          <label className="field">Role
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="staff">Front desk staff</option><option value="doctor">Doctor</option><option value="lab">Lab staff</option><option value="admin">Admin</option>
            </select>
          </label>
          {form.role === 'doctor' && (
            <label className="field">Which doctor
              <select value={form.doctorName} onChange={(e) => setForm({ ...form, doctorName: e.target.value })} required>
                <option value="">Choose…</option>{doctors.map((d) => <option key={d}>{d}</option>)}
              </select>
            </label>
          )}
        </div>
        <p className="muted small">{ROLE_HELP[form.role]}. Share the password with them; they can change it under My account.</p>
        <div><button type="submit" className="btn btn-primary">Create account</button></div>
      </form>
    </AdminLayout>
  );
}
