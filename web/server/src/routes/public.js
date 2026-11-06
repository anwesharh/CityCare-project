// src/routes/public.js — LiveKit token for website visitors + public clinic info
import { Router } from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk';
import { config } from '../config.js';
import { getSettings, publicView } from '../lib/settings.js';
import { getQueue } from '../lib/queue.js';

const router = Router();

// A visitor can start at most 10 calls per 10 minutes from one IP.
const tokenLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

export async function createVisitorToken({ displayName } = {}) {
  const { url, apiKey, apiSecret, agentName, agentConfig } = config.livekit;
  const room = `web-${crypto.randomUUID().slice(0, 8)}`;
  const identity = `visitor-${crypto.randomUUID().slice(0, 8)}`;
  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    name: (displayName || 'Website visitor').slice(0, 60),
    ttl: '15m',
  });
  at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
  if (agentName) {
    at.roomConfig = new RoomConfiguration({
      agents: [new RoomAgentDispatch({ agentName, metadata: JSON.stringify({ config: agentConfig }) })],
    });
  }
  return { token: await at.toJwt(), url, room, identity };
}

router.post('/token', tokenLimiter, async (req, res, next) => {
  try { res.json(await createVisitorToken({ displayName: req.body?.name })); } catch (e) { next(e); }
});

router.get('/clinic', async (_req, res, next) => {
  try { res.json({ clinic: publicView(await getSettings()) }); } catch (e) { next(e); }
});

// Waiting-room display + the AI receptionist ("which token is running?"). No patient names.
router.get('/queue', async (_req, res, next) => {
  try { res.json(await getQueue()); } catch (e) { next(e); }
});

router.get('/health', (_req, res) => res.json({ ok: true }));

export default router;
