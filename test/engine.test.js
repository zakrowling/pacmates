const test = require('node:test');
const assert = require('node:assert/strict');
const { GameRoom, generateRoomCode, MAZE, PELLET, STEPS_PER_TILE: S } = require('../public/engine.js');

// Builds a room with a manual clock and records every message it sends.
function makeRoom() {
  const sent = [];
  let tickFn = null;
  const room = new GameRoom('TEST', {
    broadcast: (ev, data) => sent.push({ to: '*', ev, data }),
    send: (to, ev, data) => sent.push({ to, ev, data }),
    setInterval: (fn) => { tickFn = fn; return 1; },
    clearInterval: () => { tickFn = null; },
  });
  const run = (n = 1) => { for (let i = 0; i < n && tickFn; i++) tickFn(); };
  const last = (ev) => [...sent].reverse().find((m) => m.ev === ev);
  return { room, sent, run, last, isRunning: () => tickFn !== null };
}

function startedRoom(playerCount = 4) {
  const ctx = makeRoom();
  for (let i = 1; i <= playerCount; i++) ctx.room.join(`p${i}`);
  ctx.room.start('p1');
  // Keep ghosts home unless a test releases them.
  ctx.room.ghosts.forEach((g) => { g.def = { ...g.def, releaseTick: Infinity }; });
  return ctx;
}

const tile = (e) => [e.sx / S, e.sy / S];
const placeGhost = (g, sx, sy) => Object.assign(g, {
  def: { ...g.def, releaseTick: 0 }, inHouse: false, sx, sy, dir: { x: 0, y: 0 },
});
const freezeGhost = (g) => { g.def = { ...g.def, releaseTick: Infinity }; };

test('room codes are 4 letters without I or O', () => {
  for (let i = 0; i < 500; i++) assert.match(generateRoomCode(), /^[A-HJ-NP-Z]{4}$/);
  assert.throws(() => generateRoomCode(() => true));
});

test('maze has 4 corner spawns and a ghost house', () => {
  assert.deepEqual(MAZE.spawns, [{ x: 1, y: 1 }, { x: 20, y: 1 }, { x: 1, y: 20 }, { x: 20, y: 20 }]);
  assert.deepEqual(MAZE.houseExit, { x: 10, y: 9 });
});

test('players get numbers 1-4, unique names, first is host, 5th rejected', () => {
  const { room } = makeRoom();
  const results = [1, 2, 3, 4].map((i) => room.join(`p${i}`));
  assert.ok(results.every((r) => r.ok));
  assert.equal(room.hostId, 'p1');
  const players = [...room.players.values()];
  assert.deepEqual(players.map((p) => p.number), [1, 2, 3, 4]);
  assert.equal(new Set(players.map((p) => p.name)).size, 4);
  players.forEach((p) => assert.match(p.name, /^[A-Z]{4}$/));
  assert.match(room.join('p5').error, /full/);
});

test('only the host can start; input before start is ignored', () => {
  const { room } = makeRoom();
  room.join('p1');
  room.join('p2');
  room.input('p1', 'right');
  assert.equal(room.players.get('p1').nextDir, null);
  assert.equal(room.start('p2'), false);
  assert.equal(room.start('p1'), true);
});

test('game starts with players on their corner spawns and 4 ghosts', () => {
  const { last } = startedRoom();
  const payload = last('gameStarted').data;
  const spawns = Object.fromEntries(payload.players.map((p) => [p.number, [p.x, p.y]]));
  assert.deepEqual(spawns, { 1: [1, 1], 2: [20, 1], 3: [1, 20], 4: [20, 20] });
  assert.equal(payload.ghosts.length, 4);
  assert.equal(payload.tickRate, 30);
});

test('engine owns movement: bad input ignored, walls block, dots score', () => {
  const { room, run } = startedRoom();
  const p1 = room.players.get('p1');
  const p2 = room.players.get('p2');
  room.input('p2', { x: 5, y: 5 });
  room.input('p2', 'teleport');
  room.input('p1', 'up');
  run(10);
  assert.deepEqual(tile(p2), [20, 1]);
  assert.deepEqual(tile(p1), [1, 1]);

  room.input('p1', 'right');
  run(8);
  assert.deepEqual(tile(p1), [3, 1]);
  assert.equal(p1.score, 20);
});

test('ghost catches a player, who loses a life and respawns protected', () => {
  const { room, run, sent } = startedRoom();
  const p2 = room.players.get('p2');
  placeGhost(room.ghosts[0], p2.sx, p2.sy);
  run(1);
  assert.equal(p2.status, 'dead');
  assert.equal(p2.lives, 2);
  assert.ok(sent.some((m) => m.ev === 'state' && m.data.events.some((e) => e.type === 'death' && e.id === 'p2')));

  freezeGhost(room.ghosts[0]);
  run(50);
  assert.equal(p2.status, 'alive');
  assert.ok(p2.invulnerableTicks > 0);
  assert.deepEqual(tile(p2), [20, 1]);
});

test('power pellet frightens ghosts; eating one scores and sends eyes home', () => {
  const { room, run } = startedRoom();
  const p1 = room.players.get('p1');
  room.dots[1][1] = PELLET.POWER;
  room.dotsRemaining++;
  run(1);
  assert.ok(room.ghosts.every((g) => g.frightened));

  const ghost = room.ghosts[0];
  placeGhost(ghost, p1.sx, p1.sy);
  const before = p1.score;
  run(1);
  assert.equal(ghost.eyes, true);
  assert.equal(p1.score, before + 200);
  assert.equal(p1.status, 'alive');

  let ticks = 0;
  while (ghost.eyes && ticks++ < 300) run(1);
  assert.equal(ghost.eyes, false);
});

test('released ghosts leave the house and never enter walls', () => {
  const { room, run } = startedRoom();
  room.ghosts.forEach((g) => { g.def = { ...g.def, releaseTick: 0 }; });
  room.players.forEach((p) => { p.invulnerableTicks = 1e9; });
  for (let i = 0; i < 300; i++) {
    run(1);
    for (const g of room.ghosts) {
      for (const [x, y] of [[Math.floor(g.sx / S), Math.floor(g.sy / S)], [Math.ceil(g.sx / S), Math.ceil(g.sy / S)]]) {
        assert.notEqual(MAZE.walls[y][x], 1, `${g.name} in wall at ${x},${y}`);
      }
    }
  }
  assert.ok(room.ghosts.every((g) => !g.inHouse));
});

test('mid-game join drops into the free corner without restarting the game', () => {
  const { room, run, sent } = startedRoom(3);
  run(30);
  const tickBefore = room.tick;
  const res = room.join('late');
  assert.ok(res.ok);
  room.announceJoin('late');
  const late = room.players.get('late');
  assert.equal(late.number, 4);
  assert.deepEqual(tile(late), [20, 20]);
  assert.ok(late.invulnerableTicks > 0);
  const catchUp = sent.find((m) => m.to === 'late' && m.ev === 'gameStarted');
  assert.ok(catchUp);
  assert.equal(catchUp.data.maze.dots.flat().filter(Boolean).length, room.dotsRemaining);
  run(5);
  assert.equal(room.tick, tickBefore + 5);
  assert.equal(room.started, true);
});

test('leaving migrates host; last player leaving stops the loop', () => {
  const { room, isRunning } = startedRoom(2);
  room.leave('p1');
  assert.equal(room.hostId, 'p2');
  room.leave('p2');
  assert.equal(isRunning(), false);
});

test('eating the last dot ends the game with standings', () => {
  const { room, run, last, isRunning } = startedRoom(2);
  room.dots = room.dots.map((row) => row.map(() => PELLET.NONE));
  room.dots[1][2] = PELLET.DOT;
  room.dotsRemaining = 1;
  room.input('p1', 'right');
  run(10);
  assert.equal(room.started, false);
  assert.equal(isRunning(), false);
  assert.equal(last('gameOver').data.reason, 'cleared');
  assert.equal(last('gameOver').data.standings[0].id, 'p1');
});

test('game ends when every player is out of lives', () => {
  const { room, run, last } = startedRoom(1);
  const p1 = room.players.get('p1');
  p1.lives = 0;
  p1.status = 'dead';
  p1.deadTicks = 1;
  run(1);
  assert.equal(last('gameOver').data.reason, 'ghosts');
});

test('tunnel row wraps players from one edge to the other', () => {
  const { room, run } = startedRoom(1);
  assert.deepEqual(MAZE.tunnelRows, [13]);
  const p1 = room.players.get('p1');
  Object.assign(p1, { sx: 1 * S, sy: 13 * S, dir: { x: 0, y: 0 } });
  room.input('p1', 'left');
  run(2 * S);
  assert.deepEqual(tile(p1), [MAZE.width - 1, 13]);
  room.input('p1', 'right');
  run(2 * S);
  assert.deepEqual(tile(p1), [1, 13]);
});

test('ghosts catch players across the tunnel wrap', () => {
  const { room, run } = startedRoom(1);
  const p1 = room.players.get('p1');
  Object.assign(p1, { sx: 0, sy: 13 * S, dir: { x: 0, y: 0 } });
  placeGhost(room.ghosts[0], (MAZE.width - 1) * S + 2, 13 * S);
  room.ghosts[0].dir = { x: 1, y: 0 };
  run(2);
  assert.equal(p1.status, 'dead');
});

test('a preferred name is kept when free, otherwise a random one is used', () => {
  const { room } = makeRoom();
  room.join('a', 'NOVA');
  assert.equal(room.players.get('a').name, 'NOVA');
  room.join('b', 'NOVA');
  assert.notEqual(room.players.get('b').name, 'NOVA');
  room.join('c', 'NOT-A-NAME');
  assert.match(room.players.get('c').name, /^[A-Z]{4}$/);
});
