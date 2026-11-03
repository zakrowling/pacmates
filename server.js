const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { MAZE_LAYOUT, TILE, parseMaze } = require('./maze');

const PORT = process.env.PORT || 3000;
const TICK_RATE = 30;
const STEPS_PER_TILE = 4; // movement substeps; 30 FPS / 4 = 7.5 tiles per second
const MAX_PLAYERS = 4;
const DOT_SCORE = 10;
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion with 1/0
const PLAYER_COLORS = ['#ffff00', '#ff3333', '#00ffff', '#ffb8ff'];
const PLAYER_NAMES = [
  'WAKA', 'BLIP', 'ZOOM', 'FIZZ', 'BOLT', 'DASH', 'JAZZ', 'PUCK', 'GLOW', 'NOVA',
  'MOJO', 'ZEST', 'BUZZ', 'ECHO', 'TACO', 'YETI', 'KIWI', 'FLUX', 'HOOT', 'PLUM',
  'ZINC', 'WISP', 'RUBY', 'JADE', 'ONYX', 'OPAL', 'BEAN', 'DINO', 'LUNA', 'ROXY',
];
const DIRECTIONS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const MAZE = parseMaze(MAZE_LAYOUT);

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);

/** @type {Map<string, Room>} roomCode -> room */
const rooms = new Map();

function generateRoomCode() {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += ROOM_CODE_ALPHABET[crypto.randomInt(ROOM_CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('Unable to allocate a unique room code');
}

function createRoom(hostId) {
  const code = generateRoomCode();
  const room = {
    code,
    hostId,
    players: new Map(),
    started: false,
    loop: null,
    tick: 0,
    dots: null,
    dotsRemaining: 0,
  };
  rooms.set(code, room);
  return room;
}

function isOpen(x, y) {
  return MAZE.walls[y] !== undefined && MAZE.walls[y][x] === TILE.FLOOR;
}

function nextFreePlayerNumber(room) {
  const taken = new Set([...room.players.values()].map((p) => p.number));
  for (let n = 1; n <= MAX_PLAYERS; n++) if (!taken.has(n)) return n;
  return null;
}

function randomPlayerName(room) {
  const taken = new Set([...room.players.values()].map((p) => p.name));
  const available = PLAYER_NAMES.filter((n) => !taken.has(n));
  return available[crypto.randomInt(available.length)];
}

function resetPlayerToSpawn(player) {
  const spawn = MAZE.spawns[player.number - 1];
  player.sx = spawn.x * STEPS_PER_TILE;
  player.sy = spawn.y * STEPS_PER_TILE;
  player.dir = { x: 0, y: 0 };
  player.nextDir = null;
  player.facing = 'right';
  player.score = 0;
}

function addPlayer(room, socket) {
  const number = nextFreePlayerNumber(room);
  const player = { id: socket.id, number, name: randomPlayerName(room), color: PLAYER_COLORS[number - 1] };
  resetPlayerToSpawn(player);
  room.players.set(socket.id, player);
  socket.join(room.code);
  socket.data.roomCode = room.code;
  return player;
}

function serializePlayer(p) {
  return {
    id: p.id,
    number: p.number,
    name: p.name,
    color: p.color,
    x: p.sx / STEPS_PER_TILE,
    y: p.sy / STEPS_PER_TILE,
    moving: p.dir.x !== 0 || p.dir.y !== 0,
    facing: p.facing,
    score: p.score,
  };
}

function lobbyPayload(room) {
  return {
    roomCode: room.code,
    hostId: room.hostId,
    started: room.started,
    players: [...room.players.values()].map(serializePlayer).sort((a, b) => a.number - b.number),
  };
}

function broadcastLobby(room) {
  io.to(room.code).emit('lobbyUpdate', lobbyPayload(room));
}

function stopLoop(room) {
  if (room.loop) clearInterval(room.loop);
  room.loop = null;
}

function startGame(room) {
  room.dots = MAZE.dots.map((row) => [...row]);
  room.dotsRemaining = room.dots.flat().filter(Boolean).length;
  room.tick = 0;
  room.started = true;
  room.players.forEach(resetPlayerToSpawn);

  io.to(room.code).emit('gameStarted', {
    maze: { width: MAZE.width, height: MAZE.height, walls: MAZE.walls, dots: room.dots, spawns: MAZE.spawns },
    tickRate: TICK_RATE,
    ...lobbyPayload(room),
  });

  stopLoop(room);
  room.loop = setInterval(() => gameTick(room), 1000 / TICK_RATE);
}

function stepPlayer(room, p, eaten) {
  const reversing = p.nextDir && p.nextDir.x === -p.dir.x && p.nextDir.y === -p.dir.y;
  if (reversing && (p.dir.x || p.dir.y)) p.dir = p.nextDir;

  const atCentre = p.sx % STEPS_PER_TILE === 0 && p.sy % STEPS_PER_TILE === 0;
  if (atCentre) {
    const tx = p.sx / STEPS_PER_TILE;
    const ty = p.sy / STEPS_PER_TILE;
    if (p.nextDir && isOpen(tx + p.nextDir.x, ty + p.nextDir.y)) p.dir = p.nextDir;
    if (!isOpen(tx + p.dir.x, ty + p.dir.y)) p.dir = { x: 0, y: 0 };
  }

  if (p.dir.x || p.dir.y) {
    p.sx += p.dir.x;
    p.sy += p.dir.y;
    p.facing = Object.keys(DIRECTIONS).find((k) => DIRECTIONS[k].x === p.dir.x && DIRECTIONS[k].y === p.dir.y);
  }

  if (p.sx % STEPS_PER_TILE === 0 && p.sy % STEPS_PER_TILE === 0) {
    const tx = p.sx / STEPS_PER_TILE;
    const ty = p.sy / STEPS_PER_TILE;
    if (room.dots[ty][tx]) {
      room.dots[ty][tx] = false;
      room.dotsRemaining--;
      p.score += DOT_SCORE;
      eaten.push({ x: tx, y: ty, by: p.id });
    }
  }
}

function gameTick(room) {
  room.tick++;
  const eaten = [];
  room.players.forEach((p) => stepPlayer(room, p, eaten));

  io.to(room.code).emit('state', {
    tick: room.tick,
    players: [...room.players.values()].map(serializePlayer),
    eaten,
  });

  if (room.dotsRemaining <= 0) endGame(room);
}

function endGame(room) {
  stopLoop(room);
  room.started = false;
  const standings = [...room.players.values()].map(serializePlayer).sort((a, b) => b.score - a.score);
  io.to(room.code).emit('gameOver', { standings });
  broadcastLobby(room);
}

function leaveCurrentRoom(socket) {
  const code = socket.data.roomCode;
  const room = code && rooms.get(code);
  socket.data.roomCode = null;
  if (!room) return;

  room.players.delete(socket.id);
  socket.leave(code);

  if (room.players.size === 0) {
    stopLoop(room);
    rooms.delete(code);
    return;
  }
  if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
  broadcastLobby(room);
}

io.on('connection', (socket) => {
  socket.on('createRoom', (ack) => {
    if (typeof ack !== 'function') return;
    leaveCurrentRoom(socket);
    try {
      const room = createRoom(socket.id);
      const player = addPlayer(room, socket);
      ack({ ok: true, playerId: player.id, ...lobbyPayload(room) });
    } catch (err) {
      ack({ ok: false, error: err.message });
    }
  });

  socket.on('joinRoom', (rawCode, ack) => {
    if (typeof ack !== 'function') return;
    const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
    if (!/^[A-Z]{4}$/.test(code)) return ack({ ok: false, error: 'Room codes are 4 letters.' });

    const room = rooms.get(code);
    if (!room) return ack({ ok: false, error: 'Room not found!' });
    if (room.started) return ack({ ok: false, error: 'Game already in progress!' });
    if (room.players.size >= MAX_PLAYERS) return ack({ ok: false, error: 'Room is full (max 4 players)!' });

    leaveCurrentRoom(socket);
    const player = addPlayer(room, socket);
    ack({ ok: true, playerId: player.id, ...lobbyPayload(room) });
    broadcastLobby(room);
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.started || room.hostId !== socket.id) return;
    startGame(room);
  });

  // Clients only send intent; the server owns all positions.
  socket.on('input', (direction) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room && room.started && room.players.get(socket.id);
    if (!player || !Object.hasOwn(DIRECTIONS, direction)) return;
    player.nextDir = DIRECTIONS[direction];
  });

  socket.on('leaveRoom', () => leaveCurrentRoom(socket));
  socket.on('disconnect', () => leaveCurrentRoom(socket));
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Pacmates server running on http://localhost:${PORT}`));
}

module.exports = { server, io, rooms, generateRoomCode, MAZE };
