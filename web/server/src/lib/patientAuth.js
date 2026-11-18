// src/lib/patientAuth.js — patient portal sessions, kept separate from staff logins
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

// A different signing key: a patient token can never pass the staff check, and vice versa.
const key = () => `${config.jwtSecret}:patient-portal`;

export const signPatientToken = (phoneKey) => jwt.sign({ sub: phoneKey, kind: 'patient' }, key(), { expiresIn: '7d' });

export function requirePatient(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please log in' });
  try {
    const p = jwt.verify(token, key());
    if (p.kind !== 'patient') throw new Error('wrong token');
    req.patientKey = p.sub;
    return next();
  } catch {
    return res.status(401).json({ error: 'Session expired, please log in again' });
  }
}

export const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
export const hashCode = (phoneKey, code) => crypto.createHmac('sha256', key()).update(`${phoneKey}:${code}`).digest('hex');
export function sameHash(a, b) {
  const x = Buffer.from(String(a || ''), 'hex');
  const y = Buffer.from(String(b || ''), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
