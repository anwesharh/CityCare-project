// src/lib/ocr.js — read a prescription photo/PDF with Gemini Vision.
// Based on the CalmSpace analyzer (ocr.py + report.py + medicine.py):
//  * Gemini reads the image (with model fallback and retries),
//  * medicine names are cross-checked against the text actually read, so invented names get flagged,
//  * a drug class is guessed from the name (suffix patterns, e.g. -mycin → antibiotic).
import { config } from '../config.js';

export const PRESCRIPTION_PROMPT = `You are reading a medical prescription from India. It may be handwritten.
Return ONLY valid JSON (no markdown) in exactly this shape:
{"doctor":"","date":"","patient_name":"","medicines":[{"name":"","strength":"","form":"","dose":"","morning":false,"afternoon":false,"night":false,"frequency_text":"","timing":"","duration_days":null,"instructions":""}],"advice":"","text":""}
Rules:
- "text": ALL text visible in the image, exactly as written.
- "date": YYYY-MM-DD if a date is written, else "".
- One entry per medicine. "name" exactly as written (brand or generic). "strength" like "500 mg". "form": tablet, capsule, syrup, injection, drops, cream, inhaler or "".
- Indian dosing notation: 1-0-1 = morning and night; 1-1-1 = morning, afternoon and night; 0-0-1 = night; OD = once a day (morning);
  BD = twice (morning and night); TDS = three times; QID = four times (morning, afternoon, night); HS = at bedtime (night);
  SOS/PRN = only when needed (all times false). Put what was written in "frequency_text".
- "timing": "before food", "after food" or "".
- "duration_days": a number if written (5 days = 5, 1 week = 7, 1 month = 30), else null.
- Never invent a medicine, dose or time. If something is unreadable, leave it empty.
- If the image is not a prescription, return {"medicines":[],"text":"","not_prescription":true}.`;

// From CalmSpace analyzer/medicine.py
const SUFFIX_PATTERNS = [
  [/statin$/i, 'Cholesterol (statin)'], [/olol$/i, 'Beta-blocker'], [/mycin$/i, 'Antibiotic'],
  [/cillin$/i, 'Antibiotic (penicillin)'], [/pril$/i, 'ACE inhibitor (BP)'], [/sartan$/i, 'ARB (BP)'],
  [/formin$/i, 'Antidiabetic'], [/dipine$/i, 'Calcium channel blocker (BP)'], [/prazole$/i, 'Antacid (PPI)'],
  [/oxacin$/i, 'Antibiotic (fluoroquinolone)'], [/tidine$/i, 'Antacid (H2 blocker)'], [/zine$/i, 'Antihistamine'],
];
const COMMON = {
  paracetamol: 'Fever / pain relief', dolo: 'Fever / pain relief', crocin: 'Fever / pain relief', calpol: 'Fever / pain relief',
  ibuprofen: 'Pain relief (NSAID)', aspirin: 'Pain relief / blood thinner', cetirizine: 'Antihistamine',
  montelukast: 'Allergy / asthma', pantoprazole: 'Antacid (PPI)', pan: 'Antacid (PPI)', omeprazole: 'Antacid (PPI)',
  ondansetron: 'Anti-nausea', domperidone: 'Anti-nausea', metformin: 'Antidiabetic', amoxicillin: 'Antibiotic (penicillin)',
  azithromycin: 'Antibiotic', ors: 'Rehydration', vitamin: 'Supplement', calcium: 'Supplement', iron: 'Supplement',
};

export function medicineCategory(name) {
  const words = String(name || '').toLowerCase().match(/[a-z]+/g) || [];
  for (const w of words) if (COMMON[w]) return COMMON[w];
  for (const w of words) for (const [re, cat] of SUFFIX_PATTERNS) if (w.length > 5 && re.test(w)) return cat;
  return '';
}

/** CalmSpace's anti-hallucination check: keep a medicine "verified" only if its name appears in the read text. */
export function nameFoundInText(name, text) {
  const first = String(name || '').toLowerCase().match(/[a-z]{3,}/);
  return Boolean(first && String(text || '').toLowerCase().includes(first[0]));
}

const TIME_OF = { morning: '08:00', afternoon: '14:00', night: '21:00' };

/** Turn Gemini's JSON into the saved shape (clean strings, reminder times, category, verified flag). */
export function normalisePrescription(raw) {
  const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const text = str(raw?.text, 8000);
  const medicines = (Array.isArray(raw?.medicines) ? raw.medicines : []).map((m) => {
    const name = str(m?.name, 120);
    const times = ['morning', 'afternoon', 'night'].filter((k) => m?.[k] === true).map((k) => TIME_OF[k]);
    const days = Number(m?.duration_days);
    return {
      name, strength: str(m?.strength, 60), form: str(m?.form, 40), dose: str(m?.dose, 80),
      frequencyText: str(m?.frequency_text, 60), timing: str(m?.timing, 40),
      durationDays: Number.isFinite(days) && days > 0 ? Math.min(365, Math.round(days)) : null,
      instructions: str(m?.instructions, 300), category: medicineCategory(name),
      verified: text ? nameFoundInText(name, text) : true,
      times, reminders: times.length > 0,
    };
  }).filter((m) => m.name).slice(0, 30);
  return {
    doctor: str(raw?.doctor, 120), patientName: str(raw?.patient_name, 120),
    date: /^\d{4}-\d{2}-\d{2}$/.test(raw?.date || '') ? raw.date : '',
    advice: str(raw?.advice, 1000), text, medicines,
    notPrescription: Boolean(raw?.not_prescription),
  };
}

export function parseJson(rawText) {
  const cleaned = String(rawText || '').replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  return JSON.parse(start >= 0 ? cleaned.slice(start, end + 1) : cleaned);
}

/** Read a prescription. Returns the normalised result, or throws with a friendly message. */
export async function readPrescription(buffer, contentType) {
  if (!config.gemini.apiKey) throw new Error('Add GOOGLE_API_KEY to server/.env to read prescriptions');
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [
      { text: PRESCRIPTION_PROMPT },
      { inline_data: { mime_type: contentType, data: buffer.toString('base64') } },
    ] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  });
  const models = config.gemini.models;
  let lastError = 'no model answered';
  const deadline = Date.now() + (process.env.VERCEL ? 50000 : 150000); // Vercel stops a function at 60 s
  for (let attempt = 0; attempt < models.length + 1 && Date.now() < deadline - 5000; attempt += 1) {
    const model = models[Math.min(attempt, models.length - 1)];
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
          body, signal: AbortSignal.timeout(Math.min(40000, deadline - Date.now())) },
      );
      if (!res.ok) { lastError = `${model}: HTTP ${res.status}`; await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); continue; }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
      return normalisePrescription(parseJson(text));
    } catch (e) { lastError = `${model}: ${e.message}`; }
  }
  throw new Error(`Could not read the prescription (${lastError})`);
}
