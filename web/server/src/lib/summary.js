// src/lib/summary.js — short AI summary of a call using Gemini (optional)
import { config } from '../config.js';

export function buildSummaryPrompt(call) {
  const lines = (call.transcript || [])
    .filter((l) => l.role !== 'tool' && l.text)
    .map((l) => `${l.role === 'user' ? 'Caller' : 'Receptionist'}: ${l.text}`)
    .join('\n');
  return [
    'Summarise this clinic phone call for the front-desk staff in 2-3 plain sentences.',
    'Say what the caller wanted, what was done (booked/cancelled/rescheduled/message/emergency advice)',
    'and any follow-up staff must do. Do not add medical advice. No markdown.',
    call.urgent ? 'The call was flagged URGENT for possible emergency symptoms; mention that first.' : '',
    '',
    lines.slice(0, 12000),
  ].join('\n');
}

/** Returns a summary string, or null if Gemini is not configured or every model failed. */
export async function summariseCall(call) {
  if (!config.gemini.apiKey || !(call.transcript || []).length) return null;
  const body = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: buildSummaryPrompt(call) }] }] });
  for (const model of config.gemini.models) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
          body, signal: AbortSignal.timeout(20000) },
      );
      if (!res.ok) continue; // 503 busy etc. -> try next model
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('').trim();
      if (text) return text;
    } catch { /* try next model */ }
  }
  return null;
}
