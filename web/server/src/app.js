// src/app.js — Express app (no DB connection here, so it can be tested)
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
import publicRoutes from './routes/public.js';
import authRoutes from './routes/auth.js';
import webhookRoutes from './routes/webhooks.js';
import adminRoutes from './routes/admin.js';
import manageRoutes from './routes/manage.js';
import insightRoutes from './routes/insights.js';
import hospitalRoutes from './routes/hospital.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(cors({ origin: config.clientOrigin }));
  app.use(express.json({ limit: '2mb' }));

  app.use('/api', publicRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/webhooks', webhookRoutes);
  app.use('/api/agent', webhookRoutes); // GET /api/agent/settings for the AI agent
  app.use('/api/admin', adminRoutes);
  app.use('/api/admin', manageRoutes);
  app.use('/api/admin', insightRoutes);
  app.use('/api/admin', hospitalRoutes);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // In production, serve the built React app from client/dist.
  const dist = path.resolve(process.cwd(), '../client/dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    // Google API errors carry the HTTP status in err.code (e.g. 404, 410).
    const status = Number(err.status)
      || (Number.isInteger(err.code) && err.code >= 400 && err.code < 600 ? err.code : 500);
    if (status >= 500) console.error('[error]', err);
    res.status(status).json({ error: err.message || 'Server error' });
  });
  return app;
}
