const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const questions = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));

app.get('/', (req, res) => res.redirect('/display'));
app.get('/player', (req, res) => res.sendFile(path.join(__dirname, 'public/player/index.html')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public/host/index.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'public/display/index.html')));

// socketId -> { name, score, answered }
const players = new Map();
// socketId -> answerIndex
const answers = new Map();

let phase = 'lobby'; // lobby | question | reveal | gameover
let questionIndex = -1;

function playerList() {
  return [...players.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ name, score }) => ({ name, score }));
}

function answerCount() {
  return { answered: answers.size, total: players.size };
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

  const leaderboard = playerList();
  io.to('host').emit('reveal', { correctIndex: q.correctIndex, leaderboard });
  io.to('display').emit('reveal', { correctIndex: q.correctIndex, leaderboard });

  for (const [socketId, player] of players) {
    const answerIndex = answers.get(socketId);
    io.to(socketId).emit('reveal', {
      correctIndex: q.correctIndex,
      leaderboard,
      yourAnswer: answerIndex ?? null,
      correct: answerIndex !== undefined ? answerIndex === q.correctIndex : null,
      score: player.score,
    });
  }
}

io.on('connection', (socket) => {
  socket.on('register', ({ role, name }) => {
    socket.data.role = role;
    socket.join(role);

    if (role === 'player') {
      const trimmed = (name || '').trim();
      if (!trimmed) { socket.emit('error', 'Name cannot be empty'); return; }
      if ([...players.values()].some(p => p.name === trimmed)) {
        socket.emit('error', 'Name already taken');
        return;
      }

      players.set(socket.id, { name: trimmed, score: 0, answered: false });
      socket.emit('registered');

      // Sync late-joining player to current question
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
      }

      io.emit('players-update', playerList());
    } else {
      socket.emit('registered');
      socket.emit('players-update', playerList());

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
          socket.emit('reveal', { correctIndex: q.correctIndex, leaderboard: playerList() });
        }
      }
    }
  });

  // Reset scores, keep registered players, return to lobby
  socket.on('start-game', () => {
    if (socket.data.role !== 'host') return;
    for (const player of players.values()) { player.score = 0; player.answered = false; }
    answers.clear();
    questionIndex = -1;
    phase = 'lobby';
    io.emit('game-started');
    io.emit('players-update', playerList());
  });

  socket.on('show-question', () => {
    if (socket.data.role !== 'host') return;
    if (phase !== 'lobby' && phase !== 'reveal') return;

    questionIndex++;
    if (questionIndex >= questions.length) {
      phase = 'gameover';
      io.emit('game-over', { leaderboard: playerList() });
      return;
    }

    phase = 'question';
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

  socket.on('disconnect', () => {
    if (socket.data.role === 'player') {
      players.delete(socket.id);
      answers.delete(socket.id);
      io.emit('players-update', playerList());
      if (phase === 'question') {
        io.to('host').emit('answer-count', answerCount());
        if (players.size > 0 && answers.size === players.size) triggerReveal();
      }
    }
  });
});

server.listen(PORT, () => console.log(`Listening on :${PORT}`));
