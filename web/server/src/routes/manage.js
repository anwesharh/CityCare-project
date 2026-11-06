// src/routes/manage.js — clinic settings + staff accounts (admin only)
import { Router } from 'express';
import mongoose from 'mongoose';
import { hashPassword, requireAuth, requireRole } from '../lib/auth.js';
import { User } from '../models/index.js';
import { SAMPLE_HOSPITAL, getSettings, saveSettings } from '../lib/settings.js';

const router = Router();
router.use(requireAuth);

// Sample hospital data (departments, lab tests, packages...) for the "Fill sample hospital data" button.
router.get('/settings/sample-hospital', requireRole('admin'), (_req, res) => res.json({ sample: SAMPLE_HOSPITAL }));

// Settings: everyone logged in can read (doctors list etc.), only admin can change.
router.get('/settings', async (_req, res, next) => {
  try { res.json({ settings: await getSettings() }); } catch (e) { next(e); }
});
router.put('/settings', requireRole('admin'), async (req, res, next) => {
  try { res.json({ settings: await saveSettings(req.body || {}) }); } catch (e) { next(e); }
});

// ---------- staff accounts ----------
const view = (u) => ({ id: u._id, email: u.email, name: u.name, role: u.role, doctorName: u.doctorName || null,
  active: u.active !== false, createdAt: u.createdAt });
const ROLES = ['admin', 'staff', 'doctor', 'lab'];

router.get('/users', requireRole('admin'), async (_req, res, next) => {
  try { res.json({ users: (await User.find().sort({ createdAt: 1 })).map(view) }); } catch (e) { next(e); }
});

router.post('/users', requireRole('admin'), async (req, res, next) => {
  try {
    const { email, name, password, role, doctorName } = req.body || {};
    const clean = String(email || '').toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return res.status(400).json({ error: 'Enter a valid email' });
    if (!password || String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Pick a role' });
    if (role === 'doctor' && !doctorName) return res.status(400).json({ error: 'Pick which doctor this login belongs to' });
    if (await User.findOne({ email: clean })) return res.status(409).json({ error: 'That email already has an account' });
    const user = await User.create({ email: clean, name: String(name || '').trim() || clean, role,
      doctorName: role === 'doctor' ? String(doctorName) : undefined, passwordHash: await hashPassword(String(password)) });
    return res.status(201).json({ user: view(user) });
  } catch (e) { return next(e); }
});

router.patch('/users/:id', requireRole('admin'), async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    const { name, role, doctorName, active, password } = req.body || {};
    const isSelf = String(user._id) === req.user.sub;
    if (isSelf && (active === false || (role && role !== 'admin'))) {
      return res.status(400).json({ error: "You can't remove your own admin access" });
    }
    if (name !== undefined) user.name = String(name).trim() || user.name;
    if (role && ROLES.includes(role)) user.role = role;
    if (doctorName !== undefined) user.doctorName = doctorName || undefined;
    if (active !== undefined) user.active = Boolean(active);
    if (password) {
      if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      user.passwordHash = await hashPassword(String(password));
    }
    await user.save();
    return res.json({ user: view(user) });
  } catch (e) { return next(e); }
});

router.delete('/users/:id', requireRole('admin'), async (req, res, next) => {
  try {
    if (req.params.id === req.user.sub) return res.status(400).json({ error: "You can't delete your own account" });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    await User.deleteOne({ _id: req.params.id });
    return res.json({ ok: true });
  } catch (e) { return next(e); }
});

export default router;
