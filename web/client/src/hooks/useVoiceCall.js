// src/hooks/useVoiceCall.js — connects the browser to the AI receptionist via LiveKit
import { useCallback, useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';

const AGENT_STATE_ATTR = 'lk.agent.state'; // initializing | listening | thinking | speaking
const SEGMENT_ATTR = 'lk.segment_id';
const CHAT_TOPIC = 'lk.chat'; // the agent reads typed messages on this topic

/**
 * status: idle | connecting | connected | ended | error
 * agentState: waiting | listening | thinking | speaking
 * lines: [{ id, who: 'agent'|'you', text }]
 */
export function useVoiceCall() {
  const [status, setStatus] = useState('idle');
  const [agentState, setAgentState] = useState('waiting');
  const [lines, setLines] = useState([]);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [micOn, setMicOn] = useState(true);
  const roomRef = useRef(null);
  const audioRef = useRef(null);

  const upsertLine = useCallback((id, who, text) => {
    setLines((prev) => {
      const i = prev.findIndex((l) => l.id === id);
      if (i === -1) return [...prev, { id, who, text }];
      const next = prev.slice();
      next[i] = { ...next[i], text };
      return next;
    });
  }, []);

  const cleanup = useCallback(() => {
    if (audioRef.current) audioRef.current.innerHTML = '';
    roomRef.current = null;
  }, []);

  const start = useCallback(async ({ mic = true } = {}) => {
    if (roomRef.current) return;
    setError(''); setLines([]); setSeconds(0); setAgentState('waiting'); setStatus('connecting');
    setMicOn(mic); setMuted(!mic);
    try {
      const res = await fetch('/api/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const data = await res.json().catch(() => null);
      if (!data) throw new Error('The clinic server is not running. Start it with "npm run dev" and try again.');
      if (!res.ok) throw new Error(data.error || 'Could not start the call');

      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;

      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio && audioRef.current) {
          const el = track.attach();
          audioRef.current.appendChild(el);
        }
      });
      room.on(RoomEvent.ParticipantAttributesChanged, (changed) => {
        if (changed[AGENT_STATE_ATTR]) setAgentState(changed[AGENT_STATE_ATTR]);
      });
      room.on(RoomEvent.ParticipantConnected, (p) => {
        const s = p.attributes?.[AGENT_STATE_ATTR];
        if (s) setAgentState(s);
      });
      room.on(RoomEvent.Disconnected, () => { setStatus((s) => (s === 'error' ? s : 'ended')); cleanup(); });

      // Live transcript: the agent publishes both sides on the lk.transcription topic.
      room.registerTextStreamHandler('lk.transcription', async (reader, participantInfo) => {
        const who = participantInfo.identity === room.localParticipant.identity ? 'you' : 'agent';
        const id = reader.info.attributes?.[SEGMENT_ATTR] || reader.info.id;
        let text = '';
        for await (const chunk of reader) {
          text += chunk;
          upsertLine(id, who, text);
        }
      });

      await room.connect(data.url, data.token);
      if (mic) await room.localParticipant.setMicrophoneEnabled(true);
      await room.startAudio();
      setStatus('connected');
    } catch (e) {
      setError(e?.name === 'NotAllowedError'
        ? 'Microphone permission was blocked. Allow the microphone in your browser and try again.'
        : (e?.message || 'Could not connect'));
      setStatus('error');
      try { await roomRef.current?.disconnect(); } catch { /* ignore */ }
      cleanup();
    }
  }, [cleanup, upsertLine]);

  const end = useCallback(async () => {
    try { await roomRef.current?.disconnect(); } finally { setStatus('ended'); cleanup(); }
  }, [cleanup]);

  const toggleMute = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.localParticipant.setMicrophoneEnabled(muted);
      setMuted(!muted);
      if (muted) setMicOn(true);
    } catch {
      setError('Microphone permission was blocked. You can keep typing instead.');
    }
  }, [muted]);

  /** Send a typed message to the receptionist. */
  const sendMessage = useCallback(async (text) => {
    const room = roomRef.current;
    const clean = String(text || '').trim();
    if (!room || !clean) return false;
    upsertLine(`typed-${Date.now()}`, 'you', clean);
    try {
      await room.localParticipant.sendText(clean, { topic: CHAT_TOPIC });
      return true;
    } catch {
      setError('Could not send your message. Please try again.');
      return false;
    }
  }, [upsertLine]);

  useEffect(() => {
    if (status !== 'connected') return undefined;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [status]);

  useEffect(() => () => { roomRef.current?.disconnect(); }, []);

  return { status, agentState, lines, muted, micOn, error, seconds, start, end, toggleMute, sendMessage, audioRef };
}
