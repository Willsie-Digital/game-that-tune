# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install dependencies
npm run dev          # development with nodemon (auto-restart)
npm start            # production start (used by Heroku)
```

## Architecture

Single-file Node/Express/Socket.io server (`server.js`) serving three static HTML interfaces from `public/`.

**Routes:**
- `/player` — mobile join + answer interface
- `/host` — game control panel
- `/display` — full-screen audience view with media playback

**State (server-side globals):** `players` Map (socketId → {name, score, answered}), `answers` Map (socketId → answerIndex), `phase` string, `questionIndex` number. No database — all state lives in memory and resets on server restart.

**Socket.io rooms:** each socket joins a room named after its role (`'player'`, `'host'`, `'display'`). This lets the server send different payloads to each role — e.g., `host` receives `correctIndex` with each question, `player` and `display` do not.

**Game phases:** `lobby → question → reveal → (next question or gameover)`. The host drives all transitions via `start-game`, `show-question`, and `reveal-answer` events. Auto-reveal fires when every connected player has submitted.

**Questions (`questions.json`):**
```json
[
  {
    "question": "...",
    "options": ["A", "B", "C", "D"],
    "correctIndex": 0,
    "audioUrl": "https://... or null",
    "videoUrl": "https://... or null"
  }
]
```
Questions are loaded once at startup with `fs.readFileSync`. Restart the server after editing `questions.json`.

## Heroku deployment

```bash
heroku create <app-name>
git push heroku main
```

The `Procfile` runs `node server.js`. Port is read from `process.env.PORT`.
