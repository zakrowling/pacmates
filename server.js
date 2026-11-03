const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { MAZE_LAYOUT, TILE, PELLET, parseMaze } = require('./maze');

const PORT = process.env.PORT || 3000;
const TICK_RATE = 30;
const STEPS_PER_TILE = 4; // movement substeps; players move 1 substep per tick = 7.5 tiles/s
const MAX_PLAYERS = 4;
const START_LIVES = 3;
const DOT_SCORE = 10;
const POWER_SCORE = 50;
const GHOST_SCORE = 200; // doubles for each ghost eaten during one power pellet
const DEATH_TICKS = 45;
const INVULNERABLE_TICKS = 75;
const FRIGHTENED_TICKS = 6 * TICK_RATE;
const FLASH_TICKS = 2 * TICK_RATE;
const GHOST_SPEED = { normal: 0.85, frightened: 0.5, eyes: 2, house: 0.5 };
const MODE_SCHEDULE = [['scatter', 7], ['chase', 20], ['scatter', 7], ['chase', 20], ['scatter', 5], ['chase', Infinity]];
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
// Arcade tie-break order when two directions are equally good.
const GHOST_DIR_ORDER = [DIRECTIONS.up, DIRECTIONS.left, DIRECTIONS.down, DIRECTIONS.right];

const MAZE = parseMaze(MAZE_LAYOUT);
const GHOST_DEFS = [
  { name: 'blinky', releaseTick: 0, scatter: { x: MAZE.width - 1, y: -2 } },
  { name: 'pinky', releaseTick: 3 * TICK_RATE, scatter: { x: 0, y: -2 } },
  { name: 'inky', releaseTick: 8 * TICK_RATE, scatter: { x: MAZE.width - 1, y: MAZE.height + 1 } },
  { name: 'clyde', releaseTick: 13 * TICK_RATE, scatter: { x: 0, y: MAZE.height + 1 } },
];

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);

/** roomCode -> room */
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
    ghosts: [],
    started: false,
    loop: null,
    tick: 0,
    dots: null,
    dotsRemaining: 0,
    modeIndex: 0,
    modeTicks: 0,
    frightenedTicks: 0,
    ghostCombo: 0,
  };
  rooms.set(code, room);
  return room;
}

const tileOf = (e) => ({ x: e.sx / STEPS_PER_TILE, y: e.sy / STEPS_PER_TILE });
const atTileCentre = (e) => e.sx % STEPS_PER_TILE === 0 && e.sy % STEPS_PER_TILE === 0;
const facingOf = (dir) => Object.keys(DIRECTIONS).find((k) => DIRECTIONS[k].x === dir.x && DIRECTIONS[k].y === dir.y);
const isReverse = (a, b) => (a.x || a.y) && a.x === -b.x && a.y === -b.y;

function isOpenForPlayer(x, y) {
  return MAZE.walls[y] !== undefined && MAZE.walls[y][x] === TILE.FLOOR;
}

function isOpenForGhost(g, x, y) {
  const t = MAZE.walls[y] && MAZE.walls[y][x];
  if (t === TILE.FLOOR) return true;
  return t === TILE.HOUSE && (g.eyes || g.inHouse);
}

// ---------- Players ----------

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

function respawnPlayer(player) {
  const spawn = MAZE.spawns[player.number - 1];
  player.sx = spawn.x * STEPS_PER_TILE;
  player.sy = spawn.y * STEPS_PER_TILE;
  player.dir = { x: 0, y: 0 };
  player.nextDir = null;
  player.facing = 'right';
}

function resetPlayerForGame(player) {
  respawnPlayer(player);
  player.score = 0;
  player.lives = START_LIVES;
  player.status = 'alive';
  player.deadTicks = 0;
  player.invulnerableTicks = 0;
}

function addPlayer(room, socket) {
  const number = nextFreePlayerNumber(room);
  const player = { id: socket.id, number, name: randomPlayerName(room), color: PLAYER_COLORS[number - 1] };
  resetPlayerForGame(player);
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
    lives: p.lives,
    status: p.status,
    invulnerable: p.invulnerableTicks > 0,
    deathProgress: p.status === 'dead' ? 1 - p.deadTicks / DEATH_TICKS : 0,
  };
}

function stepPlayer(room, p, events) {
  if (p.status !== 'alive') return;
  if (p.nextDir && isReverse(p.dir, p.nextDir)) p.dir = p.nextDir;

  if (atTileCentre(p)) {
    const t = tileOf(p);
    if (p.nextDir && isOpenForPlayer(t.x + p.nextDir.x, t.y + p.nextDir.y)) p.dir = p.nextDir;
    if (!isOpenForPlayer(t.x + p.dir.x, t.y + p.dir.y)) p.dir = { x: 0, y: 0 };
  }

  if (p.dir.x || p.dir.y) {
    p.sx += p.dir.x;
    p.sy += p.dir.y;
    p.facing = facingOf(p.dir);
  }

  if (!atTileCentre(p)) return;
  const t = tileOf(p);
  const pellet = room.dots[t.y][t.x];
  if (pellet === PELLET.NONE) return;
  room.dots[t.y][t.x] = PELLET.NONE;
  room.dotsRemaining--;
  p.score += pellet === PELLET.POWER ? POWER_SCORE : DOT_SCORE;
  events.push({ type: 'pellet', x: t.x, y: t.y, by: p.id, power: pellet === PELLET.POWER });
  if (pellet === PELLET.POWER) frightenGhosts(room);
}

function updatePlayerTimers(p) {
  if (p.invulnerableTicks > 0) p.invulnerableTicks--;
  if (p.status !== 'dead' || --p.deadTicks > 0) return;
  if (p.lives > 0) {
    respawnPlayer(p);
    p.status = 'alive';
    p.invulnerableTicks = INVULNERABLE_TICKS;
  } else {
    p.status = 'out';
  }
}

// ---------- Ghosts ----------

function createGhosts() {
  return GHOST_DEFS.map((def, i) => {
    const home = MAZE.ghostHouse[i % MAZE.ghostHouse.length];
    return {
      def,
      name: def.name,
      sx: home.x * STEPS_PER_TILE,
      sy: home.y * STEPS_PER_TILE,
      dir: { x: 0, y: 0 },
      facing: 'up',
      inHouse: true,
      frightened: false,
      eyes: false,
      reverse: false,
      speedAcc: 0,
    };
  });
}

function frightenGhosts(room) {
  room.frightenedTicks = FRIGHTENED_TICKS;
  room.ghostCombo = 0;
  room.ghosts.forEach((g) => {
    if (g.eyes) return;
    g.frightened = true;
    if (!g.inHouse) g.reverse = true;
  });
}

function nearestAlivePlayer(room, from) {
  let best = null;
  let bestDist = Infinity;
  room.players.forEach((p) => {
    if (p.status !== 'alive') return;
    const t = { x: p.sx / STEPS_PER_TILE, y: p.sy / STEPS_PER_TILE };
    const d = (t.x - from.x) ** 2 + (t.y - from.y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = { ...t, dir: p.dir.x || p.dir.y ? p.dir : DIRECTIONS[p.facing] };
    }
  });
  return best;
}

// Classic arcade targeting: Blinky chases, Pinky ambushes ahead, Inky flanks off Blinky, Clyde gets shy up close.
function ghostTarget(room, g, tile) {
  if (g.eyes) return MAZE.houseDoor;
  if (g.inHouse) return MAZE.houseExit;
  const mode = MODE_SCHEDULE[room.modeIndex][0];
  const prey = nearestAlivePlayer(room, tile);
  if (mode === 'scatter' || !prey) return g.def.scatter;

  switch (g.name) {
    case 'pinky':
      return { x: prey.x + prey.dir.x * 4, y: prey.y + prey.dir.y * 4 };
    case 'inky': {
      const blinky = tileOf(room.ghosts[0]);
      const ax = prey.x + prey.dir.x * 2;
      const ay = prey.y + prey.dir.y * 2;
      return { x: 2 * ax - blinky.x, y: 2 * ay - blinky.y };
    }
    case 'clyde':
      return (prey.x - tile.x) ** 2 + (prey.y - tile.y) ** 2 > 64 ? prey : g.def.scatter;
    default:
      return prey;
  }
}

function chooseGhostDir(room, g, tile) {
  const canGo = (d) => isOpenForGhost(g, tile.x + d.x, tile.y + d.y);
  let options = GHOST_DIR_ORDER.filter((d) => !isReverse(g.dir, d) && canGo(d));
  if (!options.length) options = GHOST_DIR_ORDER.filter(canGo);
  if (!options.length) return { x: 0, y: 0 };

  if (g.frightened && !g.inHouse) return options[Math.floor(Math.random() * options.length)];

  const target = ghostTarget(room, g, tile);
  let best = options[0];
  let bestDist = Infinity;
  for (const d of options) {
    const dist = (tile.x + d.x - target.x) ** 2 + (tile.y + d.y - target.y) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

function ghostSubstep(room, g) {
  if (g.reverse) {
    g.dir = { x: -g.dir.x, y: -g.dir.y };
    g.reverse = false;
  }
  if (atTileCentre(g)) {
    const tile = tileOf(g);
    const cell = MAZE.walls[tile.y][tile.x];
    if (g.eyes && cell === TILE.HOUSE) {
      g.eyes = false;
      g.frightened = false;
      g.inHouse = true;
    } else if (g.inHouse && cell === TILE.FLOOR) {
      g.inHouse = false;
    }
    g.dir = chooseGhostDir(room, g, tile);
  }
  if (g.dir.x || g.dir.y) {
    g.sx += g.dir.x;
    g.sy += g.dir.y;
    g.facing = facingOf(g.dir);
  }
}

function stepGhost(room, g) {
  if (room.tick < g.def.releaseTick) return;
  let speed = GHOST_SPEED.normal;
  if (g.eyes) speed = GHOST_SPEED.eyes;
  else if (g.inHouse) speed = GHOST_SPEED.house;
  else if (g.frightened) speed = GHOST_SPEED.frightened;

  g.speedAcc += speed;
  while (g.speedAcc >= 1) {
    g.speedAcc -= 1;
    ghostSubstep(room, g);
  }
}

function updateGhostModes(room) {
  if (room.frightenedTicks > 0) {
    if (--room.frightenedTicks === 0) room.ghosts.forEach((g) => { g.frightened = false; });
    return;
  }
  const [, seconds] = MODE_SCHEDULE[room.modeIndex];
  if (++room.modeTicks < seconds * TICK_RATE) return;
  room.modeIndex = Math.min(room.modeIndex + 1, MODE_SCHEDULE.length - 1);
  room.modeTicks = 0;
  room.ghosts.forEach((g) => { if (!g.inHouse && !g.eyes) g.reverse = true; });
}

function serializeGhost(room, g) {
  return {
    name: g.name,
    x: g.sx / STEPS_PER_TILE,
    y: g.sy / STEPS_PER_TILE,
    facing: g.facing,
    frightened: g.frightened,
    flashing: g.frightened && room.frightenedTicks < FLASH_TICKS,
    eyes: g.eyes,
  };
}

function resolveCollisions(room, events) {
  room.players.forEach((p) => {
    if (p.status !== 'alive') return;
    const pt = { x: p.sx / STEPS_PER_TILE, y: p.sy / STEPS_PER_TILE };
    for (const g of room.ghosts) {
      if (g.eyes || room.tick < g.def.releaseTick) continue;
      const gt = { x: g.sx / STEPS_PER_TILE, y: g.sy / STEPS_PER_TILE };
      if (Math.abs(pt.x - gt.x) + Math.abs(pt.y - gt.y) >= 0.75) continue;

      if (g.frightened) {
        const points = GHOST_SCORE * 2 ** Math.min(room.ghostCombo, 3);
        room.ghostCombo++;
        g.frightened = false;
        g.eyes = true;
        p.score += points;
        events.push({ type: 'ghostEaten', by: p.id, ghost: g.name, points, x: gt.x, y: gt.y });
      } else if (p.invulnerableTicks === 0) {
        p.status = 'dead';
        p.deadTicks = DEATH_TICKS;
        p.lives--;
        p.dir = { x: 0, y: 0 };
        p.nextDir = null;
        events.push({ type: 'death', id: p.id });
        break;
      }
    }
  });
}

// ---------- Room lifecycle ----------

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
  room.modeIndex = 0;
  room.modeTicks = 0;
  room.frightenedTicks = 0;
  room.ghostCombo = 0;
  room.ghosts = createGhosts();
  room.started = true;
  room.players.forEach(resetPlayerForGame);

  io.to(room.code).emit('gameStarted', {
    maze: {
      width: MAZE.width,
      height: MAZE.height,
      walls: MAZE.walls,
      dots: room.dots,
      spawns: MAZE.spawns,
      houseDoor: MAZE.houseDoor,
      houseExit: MAZE.houseExit,
    },
    tickRate: TICK_RATE,
    ghosts: room.ghosts.map((g) => serializeGhost(room, g)),
    ...lobbyPayload(room),
  });

  stopLoop(room);
  room.loop = setInterval(() => gameTick(room), 1000 / TICK_RATE);
}

function gameTick(room) {
  room.tick++;
  const events = [];
  room.players.forEach(updatePlayerTimers);
  updateGhostModes(room);
  room.players.forEach((p) => stepPlayer(room, p, events));
  resolveCollisions(room, events);
  room.ghosts.forEach((g) => stepGhost(room, g));
  resolveCollisions(room, events);

  io.to(room.code).emit('state', {
    tick: room.tick,
    players: [...room.players.values()].map(serializePlayer),
    ghosts: room.ghosts.map((g) => serializeGhost(room, g)),
    events,
  });

  const everyoneOut = room.players.size > 0 && [...room.players.values()].every((p) => p.status === 'out');
  if (room.dotsRemaining <= 0 || everyoneOut) endGame(room, everyoneOut ? 'ghosts' : 'cleared');
}

function endGame(room, reason) {
  stopLoop(room);
  room.started = false;
  const standings = [...room.players.values()].map(serializePlayer).sort((a, b) => b.score - a.score);
  io.to(room.code).emit('gameOver', { standings, reason });
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

module.exports = { server, io, rooms, generateRoomCode, MAZE, PELLET };
