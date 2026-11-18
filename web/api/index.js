// api/index.js — Vercel sends every /api/... request here (see vercel.json).
// The real code lives in server/src/serverless.js so it can use the server's packages.
// On a laptop this file is not used: npm run dev starts server/src/index.js instead.
export { default } from '../server/src/serverless.js';
