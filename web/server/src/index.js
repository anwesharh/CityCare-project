// src/index.js — connect to MongoDB, create the first admin, start the API
import mongoose from 'mongoose';
import { assertCoreConfig, config } from './config.js';
import { createApp } from './app.js';
import { seedAdmin } from './lib/auth.js';
import { calendarConfigured } from './lib/calendar.js';

async function main() {
  assertCoreConfig();
  await mongoose.connect(config.mongoUri);
  console.log('[db] connected to MongoDB');
  await seedAdmin();
  if (!calendarConfigured()) {
    console.warn('[calendar] GOOGLE_OAUTH_TOKEN_FILE not found: appointments page will be empty');
  }
  createApp().listen(config.port, () => {
    console.log(`[api] CityCare API running on http://localhost:${config.port}`);
  });
}

main().catch((e) => {
  console.error('[startup] ' + e.message);
  process.exit(1);
});
