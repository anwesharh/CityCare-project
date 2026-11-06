// src/config.js — reads .env and exposes typed settings
import 'dotenv/config';
import path from 'node:path';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in server/.env`);
  return v;
}

const resolveFromServer = (p) => (p ? path.resolve(process.cwd(), p) : '');

export const config = {
  port: Number(process.env.PORT || 4000),
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  mongoUri: process.env.MONGODB_URI || '',
  jwtSecret: process.env.JWT_SECRET || '',
  admin: {
    email: (process.env.ADMIN_EMAIL || '').toLowerCase(),
    password: process.env.ADMIN_PASSWORD || '',
    name: process.env.ADMIN_NAME || 'Clinic Admin',
  },
  livekit: {
    url: process.env.LIVEKIT_URL || '',
    apiKey: process.env.LIVEKIT_API_KEY || '',
    apiSecret: process.env.LIVEKIT_API_SECRET || '',
    // Empty = the agent auto-joins every new room (RECEPTIONIST_AGENT_NAME= in the agent's .env).
    agentName: process.env.LIVEKIT_AGENT_NAME || '',
    agentConfig: process.env.LIVEKIT_AGENT_CONFIG || 'myclinic',
  },
  webhookSecret: process.env.DASHBOARD_WEBHOOK_SECRET || '',
  calendar: {
    tokenFile: resolveFromServer(process.env.GOOGLE_OAUTH_TOKEN_FILE),
    calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
    timezone: process.env.CLINIC_TIMEZONE || 'Asia/Kolkata',
  },
  gemini: {
    apiKey: process.env.GOOGLE_API_KEY || '',
    models: (process.env.GEMINI_SUMMARY_MODELS ||
      'gemini-3.1-flash-lite,gemini-3.5-flash-lite,gemini-flash-lite-latest')
      .split(',').map((s) => s.trim()).filter(Boolean),
  },
};

export function assertCoreConfig() {
  required('MONGODB_URI');
  required('JWT_SECRET');
  required('LIVEKIT_URL');
  required('LIVEKIT_API_KEY');
  required('LIVEKIT_API_SECRET');
  required('DASHBOARD_WEBHOOK_SECRET');
}
