const test = require('node:test');
const assert = require('node:assert/strict');
const { GameRoom, generateRoomCode, MAZE, PELLET, STEPS_PER_TILE: S, START_LIVES, POWER_RESPAWN_TICKS } = require('../public/engine.js');

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

test('wide maze: 4 outer-corner spawns, one central ghost house, fully connected', () => {
  assert.equal(MAZE.width, 43);
  assert.deepEqual(MAZE.spawns, [{ x: 1, y: 1 }, { x: 41, y: 1 }, { x: 1, y: 20 }, { x: 41, y: 20 }]);
  assert.equal(MAZE.houses.length, 1);
  assert.deepEqual(MAZE.houses[0].exit, { x: 21, y: 10 });
  assert.ok(MAZE.houses[0].tiles.length >= 8);

  const open = (x, y) => MAZE.walls[y] && MAZE.walls[y][(x + MAZE.width) % MAZE.width] === 0;
  const seen = new Set(['1,1']);
  const queue = [[1, 1]];
  while (queue.length) {
    const [x, y] = queue.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = (x + dx + MAZE.width) % MAZE.width;
      const key = `${nx},${y + dy}`;
      if (open(nx, y + dy) && !seen.has(key)) { seen.add(key); queue.push([nx, y + dy]); }
    }
  }
  const floor = MAZE.walls.flat().filter((t) => t === 0).length;
  assert.equal(seen.size, floor);
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

test('any player can start, outsiders cannot; input before start is ignored', () => {
  const { room } = makeRoom();
  room.join('p1');
  room.join('p2');
  room.input('p1', 'right');
  assert.equal(room.players.get('p1').nextDir, null);
  assert.equal(room.start('stranger'), false);
  assert.equal(room.start('p2'), true);
  assert.equal(room.start('p1'), false);
});

test('game starts with players on their corner spawns and 4 ghosts', () => {
  const { last } = startedRoom();
  const payload = last('gameStarted').data;
  const spawns = Object.fromEntries(payload.players.map((p) => [p.number, [p.x, p.y]]));
  assert.deepEqual(spawns, { 1: [1, 1], 2: [41, 1], 3: [1, 20], 4: [41, 20] });
  assert.equal(payload.ghosts.length, 7);
  assert.equal(new Set(payload.ghosts.map((g) => g.kind)).size, 7);
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
  assert.deepEqual(tile(p2), [41, 1]);
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
  assert.equal(p2.lives, START_LIVES - 1);
  assert.ok(sent.some((m) => m.ev === 'state' && m.data.events.some((e) => e.type === 'death' && e.id === 'p2')));

  freezeGhost(room.ghosts[0]);
  run(50);
  assert.equal(p2.status, 'alive');
  assert.ok(p2.invulnerableTicks > 0);
  assert.deepEqual(tile(p2), [41, 1]);
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
      const wrap = (n, size) => ((n % size) + size) % size;
      for (const [fx, fy] of [[Math.floor(g.sx / S), Math.floor(g.sy / S)], [Math.ceil(g.sx / S), Math.ceil(g.sy / S)]]) {
        const [x, y] = [wrap(fx, MAZE.width), wrap(fy, MAZE.height)];
        assert.notEqual(MAZE.walls[y][x], 1, `${g.kind} in wall at ${x},${y}`);
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
  assert.deepEqual(tile(late), [41, 20]);
  assert.ok(late.invulnerableTicks > 0);
  const catchUp = sent.find((m) => m.to === 'late' && m.ev === 'gameStarted');
  assert.ok(catchUp);
  assert.equal(catchUp.data.maze.dots.flat().filter((d) => d === PELLET.DOT).length, room.dotsRemaining);
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

test('eaten ghosts return to the central house and revive there', () => {
  const { room, run } = startedRoom(1);
  const ghost = room.ghosts[0];
  Object.assign(ghost, { def: { ...ghost.def, releaseTick: 0 }, inHouse: false, eyes: true, sx: 38 * S, sy: 9 * S, dir: { x: 0, y: 0 } });
  room.players.get('p1').invulnerableTicks = 1e9;
  let ticks = 0;
  while (ghost.eyes && ticks++ < 400) run(1);
  assert.equal(ghost.eyes, false);
  const x = ghost.sx / S;
  assert.ok(x >= 19 && x <= 23, `revived at x=${x}`);
});
test('a powered Pac-Man eats an un-powered one, who respawns at their corner keeping their lives', () => {
  const { room, run, sent } = startedRoom(2);
  const [p1, p2] = [room.players.get('p1'), room.players.get('p2')];
  room.dots[1][1] = PELLET.POWER;
  room.dotsRemaining++;
  run(1);
  assert.ok(p1.poweredTicks > 0);
  assert.equal(p2.poweredTicks, 0);

  const before = p1.score;
  Object.assign(p2, { sx: p1.sx, sy: p1.sy, dir: { x: 0, y: 0 } });
  run(1);
  assert.equal(p2.status, 'dead');
  assert.equal(p2.lives, START_LIVES);
  assert.equal(p1.score, before + 200);
  assert.ok(sent.some((m) => m.ev === 'state' && m.data.events.some((e) => e.type === 'playerEaten' && e.by === 'p1' && e.id === 'p2')));

  run(50);
  assert.equal(p2.status, 'alive');
  assert.deepEqual(tile(p2), [41, 1]);
  assert.equal(p2.lives, START_LIVES);
});

test('players without a power-up, or both powered, pass through each other', () => {
  const { room, run } = startedRoom(2);
  const [p1, p2] = [room.players.get('p1'), room.players.get('p2')];
  Object.assign(p2, { sx: p1.sx, sy: p1.sy });
  run(1);
  assert.equal(p1.status, 'alive');
  assert.equal(p2.status, 'alive');

  p1.poweredTicks = 100;
  p2.poweredTicks = 100;
  run(1);
  assert.equal(p1.status, 'alive');
  assert.equal(p2.status, 'alive');
});

test('eating several things in one power-up doubles the points', () => {
  const { room, run } = startedRoom(3);
  const [p1, p2, p3] = ['p1', 'p2', 'p3'].map((id) => room.players.get(id));
  p1.poweredTicks = 100;
  p1.combo = 0;
  Object.assign(p2, { sx: p1.sx, sy: p1.sy });
  run(1);
  Object.assign(p3, { sx: p1.sx, sy: p1.sy });
  const before = p1.score;
  run(1);
  assert.equal(p1.score - before, 400);
});

test('ghost numbers scale with players: 4 for one player, +1 per extra player', () => {
  for (const [players, ghosts] of [[1, 4], [2, 5], [3, 6], [4, 7]]) {
    const { room } = startedRoom(players);
    assert.equal(room.ghosts.length, ghosts, `${players} players`);
    assert.equal(new Set(room.ghosts.map((g) => g.kind)).size, ghosts);
  }
});

test('centre column wraps players from the top edge to the bottom and back', () => {
  const { room, run } = startedRoom(1);
  assert.deepEqual(MAZE.tunnelCols, [21]);
  const p1 = room.players.get('p1');
  Object.assign(p1, { sx: 21 * S, sy: 1 * S, dir: { x: 0, y: 0 } });
  room.input('p1', 'up');
  run(2 * S);
  assert.deepEqual(tile(p1), [21, MAZE.height - 1]);
  run(S);
  assert.deepEqual(tile(p1), [21, MAZE.height - 2]);
  room.input('p1', 'down');
  run(3 * S);
  assert.deepEqual(tile(p1), [21, 1]);
});

test('joining mid-game adds the next ghost, which leaves the house shortly after', () => {
  const { room, run } = startedRoom(2);
  assert.equal(room.ghosts.length, 5);
  run(30);
  room.join('p3');
  assert.equal(room.ghosts.length, 6);
  const added = room.ghosts[5];
  assert.equal(added.kind, 'funky');
  assert.equal(added.inHouse, true);
  assert.ok(added.def.releaseTick > room.tick);

  // Leaving and rejoining doesn't keep adding ghosts.
  room.leave('p3');
  room.join('p3b');
  assert.equal(room.ghosts.length, 6);
});

test('players start with 5 lives', () => {
  const { room } = startedRoom(2);
  assert.equal(START_LIVES, 5);
  room.players.forEach((p) => assert.equal(p.lives, 5));
});

test('eaten power pellets come back in the same spot after a while', () => {
  const { room, run, sent } = startedRoom(1);
  room.dots[1][1] = PELLET.POWER;
  run(1);
  assert.equal(room.dots[1][1], PELLET.NONE);
  room.players.get('p1').sx = 3 * S; // step off the spot
  run(POWER_RESPAWN_TICKS - 2);
  assert.equal(room.dots[1][1], PELLET.NONE);
  run(2);
  assert.equal(room.dots[1][1], PELLET.POWER);
  assert.ok(sent.some((m) => m.ev === 'state' && m.data.events.some((e) => e.type === 'pelletRespawn' && e.x === 1 && e.y === 1)));
});

test('the maze is cleared once the regular dots are gone, even with power pellets left', () => {
  const { room, run, last } = startedRoom(1);
  assert.equal(room.dotsRemaining, MAZE.dots.flat().filter((d) => d === PELLET.DOT).length);
  room.dots = room.dots.map((row) => row.map((d) => (d === PELLET.POWER ? d : PELLET.NONE)));
  room.dots[1][2] = PELLET.DOT;
  room.dotsRemaining = 1;
  room.input('p1', 'right');
  run(10);
  assert.equal(last('gameOver').data.reason, 'cleared');
});

test('maze has no spots where ghosts get stuck circling', () => {
  const { room } = startedRoom(4);
  const floors = [];
  MAZE.walls.forEach((row, y) => row.forEach((t, x) => { if (t === 0) floors.push([x, y]); }));
  const dirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
  for (const modeIndex of [0, 1]) {
    for (const g of room.ghosts) {
      for (const [x, y] of floors) {
        const d = dirs[(x + y) % 4];
        Object.assign(g, { def: { ...g.def, releaseTick: 0 }, inHouse: false, eyes: false, frightened: false, sx: x * S, sy: y * S, dir: d, speedAcc: 0 });
        const seen = new Set();
        for (let t = 0; t < 240; t++) {
          room.modeIndex = modeIndex;
          room.stepGhost(g);
          if (t >= 120) seen.add(`${Math.round(g.sx / S)},${Math.round(g.sy / S)}`);
        }
        assert.ok(seen.size > 6, `${g.kind} stuck near ${x},${y} in ${modeIndex ? 'chase' : 'scatter'}: ${[...seen].join(' ')}`);
      }
    }
  }
});

test('eaten ghosts get home from anywhere in the maze', () => {
  const { room } = startedRoom(1);
  const g = room.ghosts[0];
  MAZE.walls.forEach((row, y) => row.forEach((t, x) => {
    if (t !== 0) return;
    Object.assign(g, { def: { ...g.def, releaseTick: 0 }, inHouse: false, eyes: true, frightened: false, sx: x * S, sy: y * S, dir: { x: 0, y: 0 }, speedAcc: 0 });
    let n = 0;
    while (g.eyes && n++ < 600) room.stepGhost(g);
    assert.equal(g.eyes, false, `eyes stuck from ${x},${y}`);
  }));
});

test('power pellets are spread out, not bunched together', () => {
  const pellets = [];
  MAZE.dots.forEach((row, y) => row.forEach((d, x) => { if (d === PELLET.POWER) pellets.push([x, y]); }));
  assert.equal(pellets.length, 8);
  for (const [ax, ay] of pellets) {
    for (const [bx, by] of pellets) {
      if (ax === bx && ay === by) continue;
      assert.ok(Math.abs(ax - bx) + Math.abs(ay - by) >= 10, `pellets at ${ax},${ay} and ${bx},${by} are too close`);
    }
  }
});
