# CityCare — Multilingual AI Voice Receptionist for Hospitals

An AI receptionist that answers patients in **English, Hindi and Bengali**, books, cancels and reschedules
appointments in Google Calendar, issues OPD tokens, handles lab-test bookings and report-status queries,
and alerts staff instantly on emergency calls — with a full-stack MERN website and staff dashboard.

## Features

**Voice receptionist (Python, LiveKit Agents)**
- Real-time voice and typed chat; speech-to-speech with Gemini Live (or Sarvam STT/TTS + Gemini pipeline)
- Doctor-aware booking with OPD tokens, leave days and covering doctors
- Cancels and reschedules by the caller's phone number
- Understands Indian date phrases ("kal shaam", "কাল বিকেলে", "5টা")
- Suggests the right department from symptoms (never diagnoses)
- Emergency detection in English, Hindi and Bengali → gives emergency/ambulance numbers and sends a live alert
- Answers lab-test prices and preparation, books lab slots, checks report status, OPD queue, beds,
  visiting hours and insurance/cashless questions

**Website + dashboard (MongoDB, Express, React, Node)**
- Public site with "Talk to our receptionist" (voice or text) in the browser
- Staff dashboard: appointments, call transcripts with AI summaries, messages, patients, analytics, live calls
- OPD queue control with a waiting-room TV screen, bed availability, lab reports
- Live emergency alert banner with sound
- Role-based access: admin, front desk, doctor, lab staff
- All clinic/hospital settings editable from the website — the receptionist uses them on the next call

## Architecture

```
Browser (React) ──WebRTC──► LiveKit Cloud ◄──► Python agent ──► Gemini Live / Sarvam
      │                                            │
      ▼                                            ├──► Google Calendar (bookings)
Express API ◄── webhooks, settings, report/queue ──┘
      │
      ▼
MongoDB Atlas (calls, patients, messages, reports, queue, settings)
```

## Repository layout

```
receptionist/   Python voice agent (LiveKit Agents, Gemini, Sarvam, Google Calendar)
web/            MERN website: client/ (React + Vite) and server/ (Express API)
```

## Tech stack

Python · LiveKit Agents · Gemini Live · Sarvam AI (saaras, bulbul) · Google Calendar API ·
Node.js · Express · MongoDB Atlas · Mongoose · React · Vite · JWT

## Running locally

1. **Receptionist** — see `receptionist/README.md`. Copy `.env.example` to `.env` and add your LiveKit,
   Gemini and Sarvam keys, then create a clinic config from `config/businesses/example-*.yaml`.
2. **Website** — see `web/README.md`. Copy `server/.env.example` to `server/.env`, then
   `npm run install:all` and `npm run dev`.

Secrets (`.env` files, calendar tokens, the clinic config) are never committed.

## Tests

- Receptionist: `pytest` (700+ tests)
- Website server: `npm test`

## Credits and license

The voice agent in `receptionist/` is built on [kirklandsig/AIReceptionist](https://github.com/kirklandsig/AIReceptionist)
and remains under the **GNU AGPL-3.0** (see `receptionist/LICENSE`). Added in this project: Sarvam and
Gemini Live support, Indian languages and dates, doctors and OPD tokens, cancel/reschedule, emergency
alerts, hospital features and the website integration. The website in `web/` is original work.
