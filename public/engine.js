// Authoritative Pacmates game engine. Runs in the host's browser (window.PacmatesEngine)
// and in Node for tests (require). It knows nothing about networking: the caller supplies
// broadcast(event, data) and send(playerId, event, data).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./maze.js'));
  else root.PacmatesEngine = factory(root.PacmatesMaze);
})(typeof self !== 'undefined' ? self : this, ({ MAZE_LAYOUT, TILE, PELLET, parseMaze }) => {

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

  const randInt = (n) => Math.floor(Math.random() * n);
  const tileOf = (e) => ({ x: e.sx / STEPS_PER_TILE, y: e.sy / STEPS_PER_TILE });
  const atTileCentre = (e) => e.sx % STEPS_PER_TILE === 0 && e.sy % STEPS_PER_TILE === 0;
  const facingOf = (dir) => Object.keys(DIRECTIONS).find((k) => DIRECTIONS[k].x === dir.x && DIRECTIONS[k].y === dir.y);
  const isReverse = (a, b) => (a.x || a.y) && a.x === -b.x && a.y === -b.y;

  function generateRoomCode(isTaken = () => false) {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < 4; i++) code += ROOM_CODE_ALPHABET[randInt(ROOM_CODE_ALPHABET.length)];
      if (!isTaken(code)) return code;
    }
    throw new Error('Unable to allocate a unique room code');
  }

  function isOpenForPlayer(x, y) {
    return MAZE.walls[y] !== undefined && MAZE.walls[y][x] === TILE.FLOOR;
  }

  function isOpenForGhost(g, x, y) {
    const t = MAZE.walls[y] && MAZE.walls[y][x];
    if (t === TILE.FLOOR) return true;
    return t === TILE.HOUSE && (g.eyes || g.inHouse);
  }

  // ---------- Players ----------

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

  class GameRoom {
    /**
     * @param {string} code 4-letter room code
     * @param {object} hooks broadcast(event, data), send(playerId, event, data), optional setInterval/clearInterval
     */
    constructor(code, hooks) {
      this.code = code;
      this.broadcast = hooks.broadcast;
      this.send = hooks.send;
      this.setInterval = hooks.setInterval || ((fn, ms) => setInterval(fn, ms));
      this.clearInterval = hooks.clearInterval || ((id) => clearInterval(id));
      this.hostId = null;
      this.players = new Map();
      this.ghosts = [];
      this.started = false;
      this.loop = null;
      this.tick = 0;
      this.dots = null;
      this.dotsRemaining = 0;
      this.modeIndex = 0;
      this.modeTicks = 0;
      this.frightenedTicks = 0;
      this.ghostCombo = 0;
    }

    get size() {
      return this.players.size;
    }

    // Adds a player without messaging anyone; call announceJoin() after acknowledging the joiner.
    join(id) {
      if (this.players.has(id)) return { ok: false, error: 'Already in this room.' };
      if (this.players.size >= MAX_PLAYERS) return { ok: false, error: 'Room is full (max 4 players)!' };

      const taken = new Set([...this.players.values()].map((p) => p.number));
      let number = 1;
      while (taken.has(number)) number++;
      const usedNames = new Set([...this.players.values()].map((p) => p.name));
      const names = PLAYER_NAMES.filter((n) => !usedNames.has(n));
      const player = { id, number, name: names[randInt(names.length)], color: PLAYER_COLORS[number - 1] };
      resetPlayerForGame(player);
      // Mid-game joiners drop in at their corner, briefly protected.
      if (this.started) player.invulnerableTicks = INVULNERABLE_TICKS;

      this.players.set(id, player);
      if (!this.hostId) this.hostId = id;
      return { ok: true, payload: { playerId: id, ...this.lobbyPayload() } };
    }

    announceJoin(id) {
      this.broadcastLobby();
      if (this.started) this.send(id, 'gameStarted', this.gamePayload());
    }

    leave(id) {
      if (!this.players.delete(id)) return;
      if (this.players.size === 0) {
        this.stopLoop();
        return;
      }
      if (this.hostId === id) this.hostId = this.players.keys().next().value;
      this.broadcastLobby();
    }

    start(requesterId) {
      if (this.started || requesterId !== this.hostId) return false;
      this.dots = MAZE.dots.map((row) => [...row]);
      this.dotsRemaining = this.dots.flat().filter(Boolean).length;
      this.tick = 0;
      this.modeIndex = 0;
      this.modeTicks = 0;
      this.frightenedTicks = 0;
      this.ghostCombo = 0;
      this.ghosts = createGhosts();
      this.started = true;
      this.players.forEach(resetPlayerForGame);

      this.broadcast('gameStarted', this.gamePayload());
      this.stopLoop();
      this.loop = this.setInterval(() => this.gameTick(), 1000 / TICK_RATE);
      return true;
    }

    // Clients only send intent; the engine owns all positions.
    input(id, direction) {
      const player = this.started && this.players.get(id);
      if (!player || typeof direction !== 'string' || !Object.hasOwn(DIRECTIONS, direction)) return;
      player.nextDir = DIRECTIONS[direction];
    }

    destroy() {
      this.stopLoop();
      this.started = false;
    }

    // ---------- internals ----------

    lobbyPayload() {
      return {
        roomCode: this.code,
        hostId: this.hostId,
        started: this.started,
        players: [...this.players.values()].map(serializePlayer).sort((a, b) => a.number - b.number),
      };
    }

    gamePayload() {
      return {
        maze: {
          width: MAZE.width,
          height: MAZE.height,
          walls: MAZE.walls,
          dots: this.dots,
          spawns: MAZE.spawns,
          houseDoor: MAZE.houseDoor,
          houseExit: MAZE.houseExit,
        },
        tickRate: TICK_RATE,
        ghosts: this.ghosts.map((g) => this.serializeGhost(g)),
        ...this.lobbyPayload(),
      };
    }

    broadcastLobby() {
      this.broadcast('lobbyUpdate', this.lobbyPayload());
    }

    stopLoop() {
      if (this.loop !== null) this.clearInterval(this.loop);
      this.loop = null;
    }

    gameTick() {
      this.tick++;
      const events = [];
      this.players.forEach(updatePlayerTimers);
      this.updateGhostModes();
      this.players.forEach((p) => this.stepPlayer(p, events));
      this.resolveCollisions(events);
      this.ghosts.forEach((g) => this.stepGhost(g));
      this.resolveCollisions(events);

      this.broadcast('state', {
        tick: this.tick,
        players: [...this.players.values()].map(serializePlayer),
        ghosts: this.ghosts.map((g) => this.serializeGhost(g)),
        events,
      });

      const everyoneOut = this.players.size > 0 && [...this.players.values()].every((p) => p.status === 'out');
      if (this.dotsRemaining <= 0 || everyoneOut) this.endGame(everyoneOut ? 'ghosts' : 'cleared');
    }

    endGame(reason) {
      this.stopLoop();
      this.started = false;
      const standings = [...this.players.values()].map(serializePlayer).sort((a, b) => b.score - a.score);
      this.broadcast('gameOver', { standings, reason });
      this.broadcastLobby();
    }

    stepPlayer(p, events) {
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
      const pellet = this.dots[t.y][t.x];
      if (pellet === PELLET.NONE) return;
      this.dots[t.y][t.x] = PELLET.NONE;
      this.dotsRemaining--;
      p.score += pellet === PELLET.POWER ? POWER_SCORE : DOT_SCORE;
      events.push({ type: 'pellet', x: t.x, y: t.y, by: p.id, power: pellet === PELLET.POWER });
      if (pellet === PELLET.POWER) this.frightenGhosts();
    }

    frightenGhosts() {
      this.frightenedTicks = FRIGHTENED_TICKS;
      this.ghostCombo = 0;
      this.ghosts.forEach((g) => {
        if (g.eyes) return;
        g.frightened = true;
        if (!g.inHouse) g.reverse = true;
      });
    }

    nearestAlivePlayer(from) {
      let best = null;
      let bestDist = Infinity;
      this.players.forEach((p) => {
        if (p.status !== 'alive') return;
        const t = tileOf(p);
        const d = (t.x - from.x) ** 2 + (t.y - from.y) ** 2;
        if (d < bestDist) {
          bestDist = d;
          best = { ...t, dir: p.dir.x || p.dir.y ? p.dir : DIRECTIONS[p.facing] };
        }
      });
      return best;
    }

    // Classic arcade targeting: Blinky chases, Pinky ambushes ahead, Inky flanks off Blinky, Clyde gets shy up close.
    ghostTarget(g, tile) {
      if (g.eyes) return MAZE.houseDoor;
      if (g.inHouse) return MAZE.houseExit;
      const mode = MODE_SCHEDULE[this.modeIndex][0];
      const prey = this.nearestAlivePlayer(tile);
      if (mode === 'scatter' || !prey) return g.def.scatter;

      switch (g.name) {
        case 'pinky':
          return { x: prey.x + prey.dir.x * 4, y: prey.y + prey.dir.y * 4 };
        case 'inky': {
          const blinky = tileOf(this.ghosts[0]);
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

    chooseGhostDir(g, tile) {
      const canGo = (d) => isOpenForGhost(g, tile.x + d.x, tile.y + d.y);
      let options = GHOST_DIR_ORDER.filter((d) => !isReverse(g.dir, d) && canGo(d));
      if (!options.length) options = GHOST_DIR_ORDER.filter(canGo);
      if (!options.length) return { x: 0, y: 0 };

      if (g.frightened && !g.inHouse) return options[randInt(options.length)];

      const target = this.ghostTarget(g, tile);
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

    ghostSubstep(g) {
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
        g.dir = this.chooseGhostDir(g, tile);
      }
      if (g.dir.x || g.dir.y) {
        g.sx += g.dir.x;
        g.sy += g.dir.y;
        g.facing = facingOf(g.dir);
      }
    }

    stepGhost(g) {
      if (this.tick < g.def.releaseTick) return;
      let speed = GHOST_SPEED.normal;
      if (g.eyes) speed = GHOST_SPEED.eyes;
      else if (g.inHouse) speed = GHOST_SPEED.house;
      else if (g.frightened) speed = GHOST_SPEED.frightened;

      g.speedAcc += speed;
      while (g.speedAcc >= 1) {
        g.speedAcc -= 1;
        this.ghostSubstep(g);
      }
    }

    updateGhostModes() {
      if (this.frightenedTicks > 0) {
        if (--this.frightenedTicks === 0) this.ghosts.forEach((g) => { g.frightened = false; });
        return;
      }
      const [, seconds] = MODE_SCHEDULE[this.modeIndex];
      if (++this.modeTicks < seconds * TICK_RATE) return;
      this.modeIndex = Math.min(this.modeIndex + 1, MODE_SCHEDULE.length - 1);
      this.modeTicks = 0;
      this.ghosts.forEach((g) => { if (!g.inHouse && !g.eyes) g.reverse = true; });
    }

    serializeGhost(g) {
      return {
        name: g.name,
        x: g.sx / STEPS_PER_TILE,
        y: g.sy / STEPS_PER_TILE,
        facing: g.facing,
        frightened: g.frightened,
        flashing: g.frightened && this.frightenedTicks < FLASH_TICKS,
        eyes: g.eyes,
      };
    }

    resolveCollisions(events) {
      this.players.forEach((p) => {
        if (p.status !== 'alive') return;
        const pt = tileOf(p);
        for (const g of this.ghosts) {
          if (g.eyes || this.tick < g.def.releaseTick) continue;
          const gt = tileOf(g);
          if (Math.abs(pt.x - gt.x) + Math.abs(pt.y - gt.y) >= 0.75) continue;

          if (g.frightened) {
            const points = GHOST_SCORE * 2 ** Math.min(this.ghostCombo, 3);
            this.ghostCombo++;
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
  }

  return {
    GameRoom,
    generateRoomCode,
    MAZE,
    PELLET,
    TICK_RATE,
    STEPS_PER_TILE,
    MAX_PLAYERS,
  };
});
