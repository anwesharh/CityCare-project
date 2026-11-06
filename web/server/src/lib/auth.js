// src/lib/auth.js — password hashing, JWT, admin seeding, route guards
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { User } from '../models/index.js';

export const hashPassword = (pw) => bcrypt.hash(pw, 10);
export const checkPassword = (pw, hash) => bcrypt.compare(pw, hash);

export function signToken(user) {
  return jwt.sign({
    sub: String(user._id), email: user.email, role: user.role, name: user.name,
    doctorName: user.role === 'doctor' ? user.doctorName || null : null,
  }, config.jwtSecret, { expiresIn: '12h' });
}

export function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    req.user = jwt.verify(token, config.jwtSecret);
    return next();
  } catch {
    return res.status(401).json({ error: 'Session expired, please log in again' });
  }
}

/** Allow only the given roles, e.g. requireRole('admin'). */
export const requireRole = (...roles) => (req, res, next) => (
  roles.includes(req.user?.role) ? next() : res.status(403).json({ error: 'You do not have access to this' })
);

/** Create the first admin from ADMIN_EMAIL / ADMIN_PASSWORD if that account doesn't exist. */
export async function seedAdmin() {
  const { email, password, name } = config.admin;
  if (!email || !password) return;
  const existing = await User.findOne({ email });
  if (existing) return;
  await User.create({ email, name, role: 'admin', passwordHash: await hashPassword(password) });
  console.log(`[auth] created admin account ${email}`);
}
