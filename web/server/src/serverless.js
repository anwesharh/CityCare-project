// src/serverless.js — the whole Express API as one Vercel function (used by web/api/index.js).
// Vercel sends every /api/... request here (see vercel.json). On a laptop this file is not used:
// npm run dev starts server/src/index.js instead.
import mongoose from 'mongoose';
import { createApp } from './app.js';
import { assertCoreConfig, config } from './config.js';
import { seedAdmin } from './lib/auth.js';

const app = createApp();
let ready = null;

/** Connect once per server instance and reuse the connection for later requests. */
function connect() {
  if (!ready) {
    ready = (async () => {
      assertCoreConfig();
      await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
      await seedAdmin();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

export default async function handler(req, res) {
  try {
    await connect();
  } catch (e) {
    console.error('[startup]', e.message);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: `Server not ready: ${e.message}` }));
  }
  return app(req, res);
}
