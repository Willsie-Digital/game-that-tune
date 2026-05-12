const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3737;
const questions = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));

app.use('/audio', express.static(path.join(__dirname, 'public/audio')));
app.use('/display-media', express.static(path.join(__dirname, 'public/display')));

app.get('/', (req, res) => res.redirect('/display'));
app.get('/player', (req, res) => res.sendFile(path.join(__dirname, 'public/player/index.html')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public/host/index.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'public/display/index.html')));

// socketId -> { name, score, answered, hidden, joinNumber }
const players = new Map();
// socketId -> answerIndex
const answers = new Map();
// sessionToken -> { name, score, hidden, joinNumber }  (disconnected players)
const sessions = new Map();

let phase = 'lobby'; // lobby | question | reveal | gameover
let questionIndex = -1;
let joinCounter = 0;
let lastReveal = null; // { correctIndex, tally } — used to sync reconnecting players

// forHost=true: includes socketId + hidden flag; never send to players/display
function playerList(forHost = false) {
  return [...players.entries()]
    .sort(([, a], [, b]) => b.score - a.score)
    .map(([socketId, { name, score, hidden, joinNumber }]) => {
      if (forHost) return { socketId, name, score, hidden, joinNumber };
      return { name: hidden ? `Player ${joinNumber}` : name, score };
    });
}

function emitPlayersUpdate() {
  io.to('host').emit('players-update', playerList(true));
  io.to('display').emit('players-update', playerList(false));
}

function answerCount() {
  return { answered: answers.size, total: players.size };
}

// Sends the current game state to a newly registered/reconnected player socket
function syncPlayerToPhase(socket) {
  if (phase === 'question') {
    const q = questions[questionIndex];
    socket.emit('question', {
      index: questionIndex,
      total: questions.length,
      question: q.question,
      options: q.options,
      audioUrl: q.audioUrl || null,
      videoUrl: q.videoUrl || null,
    });
  } else if (phase === 'reveal' && lastReveal) {
    const player = players.get(socket.id);
    socket.emit('reveal', {
      ...lastReveal,
      leaderboard: playerList(false),
      yourAnswer: null,
      correct: null,
      score: player ? player.score : 0,
    });
  }
}

function triggerReveal() {
  if (phase !== 'question') return;
  phase = 'reveal';

  const q = questions[questionIndex];
  for (const [socketId, answerIndex] of answers) {
    if (answerIndex === q.correctIndex) {
      const player = players.get(socketId);
      if (player) player.score++;
    }
  }

  const tally = Array(q.options.length).fill(0);
  for (const answerIndex of answers.values()) tally[answerIndex]++;
  lastReveal = { correctIndex: q.correctIndex, tally };

  emitPlayersUpdate();
  io.to('host').emit('reveal', { correctIndex: q.correctIndex, leaderboard: playerList(true), tally });
  io.to('display').emit('reveal', { correctIndex: q.correctIndex, leaderboard: playerList(false), tally });

  for (const [socketId, player] of players) {
    const answerIndex = answers.get(socketId);
    io.to(socketId).emit('reveal', {
      correctIndex: q.correctIndex,
      leaderboard: playerList(false),
      tally,
      yourAnswer: answerIndex ?? null,
      correct: answerIndex !== undefined ? answerIndex === q.correctIndex : null,
      score: player.score,
    });
  }
}

io.on('connection', (socket) => {
  socket.on('register', ({ role, name, sessionToken }) => {
    socket.data.role = role;
    socket.join(role);

    if (role === 'player') {
      // Restore disconnected session
      if (sessionToken && sessions.has(sessionToken)) {
        const saved = sessions.get(sessionToken);
        sessions.delete(sessionToken);
        socket.data.sessionToken = sessionToken;
        players.set(socket.id, { ...saved, answered: false });
        socket.emit('registered', { sessionToken, reconnected: true, name: saved.name });
        syncPlayerToPhase(socket);
        emitPlayersUpdate();
        return;
      }

      // Token not in sessions — check if the old socket is still alive (server hasn't detected disconnect yet)
      if (sessionToken) {
        for (const [sid, s] of io.sockets.sockets) {
          if (sid !== socket.id && s.data.sessionToken === sessionToken) {
            const player = players.get(sid);
            if (player) {
              players.delete(sid);
              answers.delete(sid);
              s.disconnect(true);
              socket.data.sessionToken = sessionToken;
              players.set(socket.id, { ...player });
              socket.emit('registered', { sessionToken, reconnected: true, name: player.name });
              syncPlayerToPhase(socket);
              emitPlayersUpdate();
              return;
            }
            break;
          }
        }
        socket.emit('session-expired');
        return;
      }

      // Fresh registration
      const trimmed = (name || '').trim();
      if (!trimmed) { socket.emit('error', 'Name cannot be empty'); return; }
      if ([...players.values()].some(p => p.name === trimmed)) {
        socket.emit('error', 'Name already taken');
        return;
      }

      const token = crypto.randomUUID();
      socket.data.sessionToken = token;
      players.set(socket.id, { name: trimmed, score: 0, answered: false, hidden: false, joinNumber: ++joinCounter });
      socket.emit('registered', { sessionToken: token, reconnected: false });
      syncPlayerToPhase(socket);
      emitPlayersUpdate();
    } else {
      socket.emit('registered');
      socket.emit('players-update', playerList(role === 'host'));

      // Sync host/display to in-progress game
      if (phase !== 'lobby' && phase !== 'gameover') {
        const q = questions[questionIndex];
        const base = {
          index: questionIndex,
          total: questions.length,
          question: q.question,
          options: q.options,
          audioUrl: q.audioUrl || null,
          videoUrl: q.videoUrl || null,
        };
        socket.emit('question', role === 'host' ? { ...base, correctIndex: q.correctIndex } : base);
        if (role === 'host') socket.emit('answer-count', answerCount());
        if (phase === 'reveal') {
          socket.emit('reveal', { correctIndex: q.correctIndex, leaderboard: playerList(role === 'host') });
        }
      }
    }
  });

  // Reset scores, clear sessions, return to lobby
  socket.on('start-game', () => {
    if (socket.data.role !== 'host') return;
    for (const player of players.values()) { player.score = 0; player.answered = false; }
    answers.clear();
    sessions.clear();
    lastReveal = null;
    questionIndex = -1;
    phase = 'lobby';
    io.emit('game-started');
    emitPlayersUpdate();
  });

  socket.on('show-question', () => {
    if (socket.data.role !== 'host') return;
    if (phase !== 'lobby' && phase !== 'reveal') return;

    questionIndex++;
    if (questionIndex >= questions.length) {
      phase = 'gameover';
      io.to('host').emit('game-over', { leaderboard: playerList(true) });
      io.to('display').emit('game-over', { leaderboard: playerList(false) });
      io.to('player').emit('game-over', { leaderboard: playerList(false) });
      return;
    }

    phase = 'question';
    lastReveal = null;
    answers.clear();
    for (const player of players.values()) player.answered = false;

    const q = questions[questionIndex];
    const base = {
      index: questionIndex,
      total: questions.length,
      question: q.question,
      options: q.options,
      audioUrl: q.audioUrl || null,
      videoUrl: q.videoUrl || null,
    };

    io.to('host').emit('question', { ...base, correctIndex: q.correctIndex });
    io.to('display').emit('question', base);
    io.to('player').emit('question', base);
    io.to('host').emit('answer-count', answerCount());
  });

  socket.on('submit-answer', ({ answerIndex }) => {
    if (socket.data.role !== 'player') return;
    if (phase !== 'question') return;
    const player = players.get(socket.id);
    if (!player || player.answered) return;

    player.answered = true;
    answers.set(socket.id, answerIndex);
    socket.emit('answer-submitted');
    io.to('host').emit('answer-count', answerCount());

    if (players.size > 0 && answers.size === players.size) triggerReveal();
  });

  socket.on('reveal-answer', () => {
    if (socket.data.role !== 'host') return;
    triggerReveal();
  });

  socket.on('audio-control', ({ action }) => {
    if (socket.data.role !== 'host') return;
    io.to('display').emit('audio-control', { action });
  });

  socket.on('set-player-hidden', ({ socketId, hidden }) => {
    if (socket.data.role !== 'host') return;
    const player = players.get(socketId);
    if (!player) return;
    player.hidden = hidden;
    emitPlayersUpdate();
  });

  socket.on('disconnect', () => {
    if (socket.data.role === 'player') {
      const player = players.get(socket.id);
      // Save session so the player can reconnect without re-entering their name
      if (player && socket.data.sessionToken) {
        sessions.set(socket.data.sessionToken, {
          name: player.name,
          score: player.score,
          hidden: player.hidden,
          joinNumber: player.joinNumber,
        });
      }
      players.delete(socket.id);
      answers.delete(socket.id);
      emitPlayersUpdate();
      if (phase === 'question') {
        io.to('host').emit('answer-count', answerCount());
        if (players.size > 0 && answers.size === players.size) triggerReveal();
      }
    }
  });
});

server.listen(PORT, () => console.log(`Listening on :${PORT}`));
