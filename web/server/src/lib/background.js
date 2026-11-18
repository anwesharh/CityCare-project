// src/lib/background.js — run work after the reply is sent.
// On a laptop the server keeps running, so the promise just finishes.
// On Vercel the function would be frozen after the reply, so we tell Vercel to wait for it.
import { waitUntil } from '@vercel/functions';

export function runInBackground(promise, label = 'background') {
  const p = Promise.resolve(promise).catch((e) => console.error(`[${label}] failed:`, e?.message || e));
  if (process.env.VERCEL) {
    try { waitUntil(p); } catch { /* not inside a Vercel request */ }
  }
  return p;
}
