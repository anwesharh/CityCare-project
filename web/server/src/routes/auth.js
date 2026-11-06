// src/routes/auth.js — staff login + change own password
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { User } from '../models/index.js';
import { checkPassword, hashPassword, requireAuth, signToken } from '../lib/auth.js';

const router = Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20 });

const publicUser = (u) => ({ email: u.email, name: u.name, role: u.role, doctorName: u.doctorName || null });

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').toLowerCase().trim();
    const password = String(req.body?.password || '');
    const user = email && await User.findOne({ email });
    if (!user || user.active === false || !(await checkPassword(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Wrong email or password' });
    }
    return res.json({ token: signToken(user), user: publicUser(user) });
  } catch (e) { return next(e); }
});

router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

router.post('/password', requireAuth, async (req, res, next) => {
  try {
    const { current, next: nextPw } = req.body || {};
    if (!nextPw || String(nextPw).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    const user = await User.findById(req.user.sub);
    if (!user || !(await checkPassword(String(current || ''), user.passwordHash))) {
      return res.status(400).json({ error: 'Current password is wrong' });
    }
    user.passwordHash = await hashPassword(String(nextPw));
    await user.save();
    return res.json({ ok: true });
  } catch (e) { return next(e); }
});

export default router;
