// Authoritative Pacmates game engine. Runs in the host's browser (window.PacmatesEngine)
// and in Node for tests (require). It knows nothing about networking: the caller supplies
// broadcast(event, data) and send(playerId, event, data).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./maze.js'));
  else root.PacmatesEngine = factory(root.PacmatesMaze);
})(typeof self !== 'undefined' ? self : this, ({ MAZE_LAYOUT, TILE, PELLET, parseMaze }) => {

  const TICK_RATE = 30;
  // Each round opens with a frozen "READY!" while the start jingle (pacman-theme.mp3, ~5.8s) plays.
  const READY_TICKS = 6 * TICK_RATE;
  const STEPS_PER_TILE = 4; // movement substeps; players move 1 substep per tick = 7.5 tiles/s
  const MAX_PLAYERS = 4;
  const START_LIVES = 5;
  const DOT_SCORE = 10;
  const POWER_SCORE = 50;
  const GHOST_SCORE = 200; // doubles for each ghost or player eaten during one power-up
  const DEATH_TICKS = 45;
  const INVULNERABLE_TICKS = 75;
  const FRIGHTENED_TICKS = 6 * TICK_RATE;
  const FLASH_TICKS = 2 * TICK_RATE;
  const POWER_RESPAWN_TICKS = 20 * TICK_RATE; // eaten power pellets come back in the same spot
  const GHOST_SPEED = { normal: 0.85, frightened: 0.5, eyes: 2, house: 0.5, tunnel: 0.45 };
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
  const MID_X = Math.floor(MAZE.width / 2);
  const MID_Y = Math.floor(MAZE.height / 2);
  // Eight ghosts share the central house. Each has its own colour (client side), its own patch of the
  // maze to scatter to, and its own chase style, and they leave the house one after another.
  const GHOST_KINDS = [
    { kind: 'blinky', scatter: { x: MAZE.width - 1, y: -2 } }, // chases directly; top-right
    { kind: 'pinky', scatter: { x: 0, y: -2 } }, // ambushes ahead; top-left
    { kind: 'inky', scatter: { x: MAZE.width - 1, y: MAZE.height + 1 } }, // flanks off Blinky; bottom-right
    { kind: 'clyde', scatter: { x: 0, y: MAZE.height + 1 } }, // chases until close, then retreats; bottom-left
    { kind: 'sue', scatter: { x: MID_X, y: -2 } }, // sneaks up from behind; top-middle
    { kind: 'funky', scatter: { x: MID_X, y: MAZE.height + 1 } }, // unpredictable wanderer; bottom-middle
    { kind: 'spunky', scatter: { x: -2, y: MID_Y } }, // patrols, only chases when close; far left
    { kind: 'tim', scatter: { x: MAZE.width + 1, y: MID_Y } }, // cuts players off far ahead; far right
  ];
  const RELEASE_INTERVAL_TICKS = 2 * TICK_RATE;
  // More players, more ghosts: 4 for one player, plus one per extra player.
  const ghostCountFor = (players) => Math.min(GHOST_KINDS.length, 3 + Math.max(1, players));
  const GHOST_DEFS = GHOST_KINDS.map((k, index) => {
    const house = MAZE.houses[index % MAZE.houses.length];
    return {
      id: k.kind,
      kind: k.kind,
      index,
      house,
      home: house.tiles[Math.floor(index / MAZE.houses.length) % house.tiles.length],
      releaseTick: index * RELEASE_INTERVAL_TICKS,
      scatter: k.scatter,
    };
  });

  const mod = (n, m) => ((n % m) + m) % m;
  const randInt = (n) => Math.floor(Math.random() * n);
  // Tunnels wrap left <-> right and top <-> bottom.
  const wrapX = (x) => mod(x, MAZE.width);
  const wrapY = (y) => mod(y, MAZE.height);
  const wrapStepsX = (sx) => mod(sx, MAZE.width * STEPS_PER_TILE);
  const wrapStepsY = (sy) => mod(sy, MAZE.height * STEPS_PER_TILE);
  // Distance the short way round, so tunnels count as adjacent.
  const wrapDist = (a, b, size) => {
    const d = Math.abs(a - b);
    return Math.min(d, size - d);
  };
  const wrapDx = (a, b) => wrapDist(a, b, MAZE.width);
  const wrapDy = (a, b) => wrapDist(a, b, MAZE.height);
  const onEdge = (x, y) => x === 0 || y === 0 || x === MAZE.width - 1 || y === MAZE.height - 1;
  const isTunnelTile = (x, y) => onEdge(x, y) && MAZE.walls[y][x] === TILE.FLOOR;
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
    return MAZE.walls[wrapY(y)][wrapX(x)] === TILE.FLOOR;
  }

  function isOpenForGhost(g, x, y) {
    const t = MAZE.walls[wrapY(y)][wrapX(x)];
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
    player.poweredTicks = 0;
    player.combo = 0;
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
      powered: p.poweredTicks > 0,
      poweredFlashing: p.poweredTicks > 0 && p.poweredTicks < FLASH_TICKS,
      deathProgress: p.status === 'dead' ? 1 - p.deadTicks / DEATH_TICKS : 0,
    };
  }

  function updatePlayerTimers(p) {
    if (p.invulnerableTicks > 0) p.invulnerableTicks--;
    if (p.poweredTicks > 0) p.poweredTicks--;
    if (p.status !== 'dead' || --p.deadTicks > 0) return;
    // Lives are only lost to ghosts; players eaten by another Pac-Man come straight back.
    if (p.lives > 0) {
      respawnPlayer(p);
      p.status = 'alive';
      p.invulnerableTicks = INVULNERABLE_TICKS;
    } else {
      p.status = 'out';
    }
  }

  // ---------- Ghosts ----------

  function createGhosts(playerCount) {
    return GHOST_DEFS.slice(0, ghostCountFor(playerCount)).map((def) => makeGhost(def));
  }

  function makeGhost(def) {
    return {
      def,
      id: def.id,
      kind: def.kind,
      sx: def.home.x * STEPS_PER_TILE,
      sy: def.home.y * STEPS_PER_TILE,
      dir: { x: 0, y: 0 },
      facing: 'up',
      inHouse: true,
      frightened: false,
      eyes: false,
      reverse: false,
      speedAcc: 0,
    };
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
      this.readyDuration = hooks.readyTicks ?? READY_TICKS; // tests use 0
      this.readyTicks = 0;
      this.hostId = null;
      this.players = new Map();
      this.ghosts = [];
      this.started = false;
      this.loop = null;
      this.tick = 0;
      this.dots = null;
      this.dotsRemaining = 0; // regular dots only; power pellets respawn so they don't count
      this.powerRespawns = [];
      this.modeIndex = 0;
      this.modeTicks = 0;
      this.frightenedTicks = 0;
    }

    get size() {
      return this.players.size;
    }

    // Adds a player without messaging anyone; call announceJoin() after acknowledging the joiner.
    // preferredName keeps a player's name when they move to a new host after a handover.
    join(id, preferredName) {
      if (this.players.has(id)) return { ok: false, error: 'Already in this room.' };
      if (this.players.size >= MAX_PLAYERS) return { ok: false, error: 'Room is full (max 4 players)!' };

      const taken = new Set([...this.players.values()].map((p) => p.number));
      let number = 1;
      while (taken.has(number)) number++;
      const usedNames = new Set([...this.players.values()].map((p) => p.name));
      const names = PLAYER_NAMES.filter((n) => !usedNames.has(n));
      const name = names.includes(preferredName) ? preferredName : names[randInt(names.length)];
      const player = { id, number, name, color: PLAYER_COLORS[number - 1] };
      resetPlayerForGame(player);
      // Mid-game joiners drop in at their corner, briefly protected.
      if (this.started) player.invulnerableTicks = INVULNERABLE_TICKS;

      this.players.set(id, player);
      if (this.started) this.addGhostsForPlayers();
      if (!this.hostId) this.hostId = id;
      return { ok: true, payload: { playerId: id, ...this.lobbyPayload() } };
    }

    // Mid-game joiners bring the next ghost in line, which leaves the house shortly after.
    addGhostsForPlayers() {
      while (this.ghosts.length < ghostCountFor(this.players.size)) {
        const def = GHOST_DEFS[this.ghosts.length];
        this.ghosts.push(makeGhost({ ...def, releaseTick: this.tick + RELEASE_INTERVAL_TICKS }));
      }
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

    // Any player in the room can start (or restart) the game.
    start(requesterId) {
      if (this.started || !this.players.has(requesterId)) return false;
      this.dots = MAZE.dots.map((row) => [...row]);
      this.dotsRemaining = this.dots.flat().filter((d) => d === PELLET.DOT).length;
      this.powerRespawns = [];
      this.tick = 0;
      this.modeIndex = 0;
      this.modeTicks = 0;
      this.frightenedTicks = 0;
      this.ghosts = createGhosts(this.players.size);
      this.started = true;
      this.readyTicks = this.readyDuration;
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
          houses: MAZE.houses.map((h) => ({ door: h.door, exit: h.exit })),
          tunnelRows: MAZE.tunnelRows,
          tunnelCols: MAZE.tunnelCols,
        },
        tickRate: TICK_RATE,
        readyTicks: this.readyTicks,
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
      // Frozen "READY!" at the start of the round: nothing moves and the game clock doesn't run
      // (ghost release times count from the end of it). Turns pressed now are kept for the start.
      if (this.readyTicks > 0) {
        this.readyTicks--;
        this.broadcast('state', {
          tick: this.tick,
          readyTicks: this.readyTicks,
          players: [...this.players.values()].map(serializePlayer),
          ghosts: this.ghosts.map((g) => this.serializeGhost(g)),
          events: [],
        });
        return;
      }
      this.tick++;
      const events = [];
      this.players.forEach(updatePlayerTimers);
      this.updateGhostModes();
      this.players.forEach((p) => this.stepPlayer(p, events));
      this.resolveCollisions(events);
      this.ghosts.forEach((g) => this.stepGhost(g));
      this.resolveCollisions(events);
      this.respawnPowerPellets(events);

      this.broadcast('state', {
        tick: this.tick,
        readyTicks: 0,
        players: [...this.players.values()].map(serializePlayer),
        ghosts: this.ghosts.map((g) => this.serializeGhost(g)),
        events,
      });

      const everyoneOut = this.players.size > 0 && [...this.players.values()].every((p) => p.status === 'out');
      if (this.dotsRemaining <= 0 || everyoneOut) this.endGame(everyoneOut ? 'ghosts' : 'cleared');
    }

    respawnPowerPellets(events) {
      this.powerRespawns = this.powerRespawns.filter(({ x, y, tick }) => {
        if (this.tick < tick) return true;
        this.dots[y][x] = PELLET.POWER;
        events.push({ type: 'pelletRespawn', x, y });
        return false;
      });
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
        p.sx = wrapStepsX(p.sx + p.dir.x);
        p.sy = wrapStepsY(p.sy + p.dir.y);
        p.facing = facingOf(p.dir);
      }

      if (!atTileCentre(p)) return;
      const t = tileOf(p);
      const pellet = this.dots[t.y][t.x];
      if (pellet === PELLET.NONE) return;
      this.dots[t.y][t.x] = PELLET.NONE;
      if (pellet === PELLET.DOT) this.dotsRemaining--;
      else this.powerRespawns.push({ x: t.x, y: t.y, tick: this.tick + POWER_RESPAWN_TICKS });
      p.score += pellet === PELLET.POWER ? POWER_SCORE : DOT_SCORE;
      events.push({ type: 'pellet', x: t.x, y: t.y, by: p.id, power: pellet === PELLET.POWER });
      if (pellet === PELLET.POWER) {
        // A power pellet lets this player eat ghosts and un-powered players for a while.
        p.poweredTicks = FRIGHTENED_TICKS;
        p.combo = 0;
        this.frightenGhosts();
      }
    }

    frightenGhosts() {
      this.frightenedTicks = FRIGHTENED_TICKS;
      this.ghosts.forEach((g) => {
        if (g.eyes) return;
        g.frightened = true;
        if (!g.inHouse) g.reverse = true;
      });
    }

    // Ghosts share out the players (ghost 1 -> player 1, ghost 2 -> player 2, ...) so they spread
    // across the maze instead of all hunting whoever is closest.
    assignedPrey(g) {
      const alive = [...this.players.values()].filter((p) => p.status === 'alive').sort((a, b) => a.number - b.number);
      if (!alive.length) return null;
      const p = alive[g.def.index % alive.length];
      return { ...tileOf(p), dir: p.dir.x || p.dir.y ? p.dir : DIRECTIONS[p.facing] };
    }

    isChasing() {
      return MODE_SCHEDULE[this.modeIndex][0] === 'chase';
    }

    ghostTarget(g, tile) {
      if (g.eyes) return g.def.house.door;
      if (g.inHouse) return g.def.house.exit;
      const prey = this.assignedPrey(g);
      if (!this.isChasing() || !prey) return g.def.scatter;
      const distSq = (prey.x - tile.x) ** 2 + (prey.y - tile.y) ** 2;

      switch (g.kind) {
        case 'pinky':
          return { x: prey.x + prey.dir.x * 4, y: prey.y + prey.dir.y * 4 };
        case 'inky': {
          const blinky = tileOf(this.ghosts.find((o) => o.kind === 'blinky') || g);
          const ax = prey.x + prey.dir.x * 2;
          const ay = prey.y + prey.dir.y * 2;
          return { x: 2 * ax - blinky.x, y: 2 * ay - blinky.y };
        }
        case 'clyde':
          return distSq > 64 ? prey : g.def.scatter;
        case 'sue':
          return { x: prey.x - prey.dir.x * 4, y: prey.y - prey.dir.y * 4 };
        case 'spunky':
          return distSq < 64 ? prey : g.def.scatter;
        case 'tim':
          return { x: prey.x + prey.dir.x * 8, y: prey.y + prey.dir.y * 8 };
        default:
          return prey; // blinky, and funky when it isn't wandering
      }
    }

    chooseGhostDir(g, tile) {
      const canGo = (d) => isOpenForGhost(g, tile.x + d.x, tile.y + d.y);
      let options = GHOST_DIR_ORDER.filter((d) => !isReverse(g.dir, d) && canGo(d));
      if (!options.length) options = GHOST_DIR_ORDER.filter(canGo);
      if (!options.length) return { x: 0, y: 0 };

      // Frightened ghosts flee at random; Funky also wanders randomly half the time while chasing.
      const wandering = g.kind === 'funky' && this.isChasing() && Math.random() < 0.5;
      if ((g.frightened || wandering) && !g.inHouse && !g.eyes) return options[randInt(options.length)];

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
        g.sx = wrapStepsX(g.sx + g.dir.x);
        g.sy = wrapStepsY(g.sy + g.dir.y);
        g.facing = facingOf(g.dir);
      }
    }

    stepGhost(g) {
      if (this.tick < g.def.releaseTick) return;
      let speed = GHOST_SPEED.normal;
      if (g.eyes) speed = GHOST_SPEED.eyes;
      else if (g.inHouse) speed = GHOST_SPEED.house;
      else if (g.frightened) speed = GHOST_SPEED.frightened;
      // Ghosts crawl through tunnels, as in the arcade.
      if (!g.eyes && isTunnelTile(wrapX(Math.round(g.sx / STEPS_PER_TILE)), wrapY(Math.round(g.sy / STEPS_PER_TILE)))) {
        speed = Math.min(speed, GHOST_SPEED.tunnel);
      }

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
        id: g.id,
        kind: g.kind,
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
          if (wrapDx(pt.x, gt.x) + wrapDy(pt.y, gt.y) >= 0.75) continue;

          if (g.frightened) {
            const points = GHOST_SCORE * 2 ** Math.min(p.combo, 3);
            p.combo++;
            g.frightened = false;
            g.eyes = true;
            p.score += points;
            events.push({ type: 'ghostEaten', by: p.id, ghost: g.kind, points, x: gt.x, y: gt.y });
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
      this.resolvePlayerCollisions(events);
    }

    // A powered-up Pac-Man eats any un-powered Pac-Man it touches; the eaten player
    // goes back to their corner without losing a life.
    resolvePlayerCollisions(events) {
      const alive = [...this.players.values()].filter((p) => p.status === 'alive');
      for (const eater of alive) {
        if (eater.poweredTicks === 0 || eater.status !== 'alive') continue;
        for (const prey of alive) {
          if (prey === eater || prey.status !== 'alive' || prey.poweredTicks > 0 || prey.invulnerableTicks > 0) continue;
          const a = tileOf(eater);
          const b = tileOf(prey);
          if (wrapDx(a.x, b.x) + wrapDy(a.y, b.y) >= 0.75) continue;

          const points = GHOST_SCORE * 2 ** Math.min(eater.combo, 3);
          eater.combo++;
          eater.score += points;
          prey.status = 'dead';
          prey.deadTicks = DEATH_TICKS;
          prey.dir = { x: 0, y: 0 };
          prey.nextDir = null;
          events.push({ type: 'playerEaten', by: eater.id, id: prey.id, points, x: b.x, y: b.y });
        }
      }
    }
  }

  return {
    GameRoom,
    generateRoomCode,
    MAZE,
    PELLET,
    TICK_RATE,
    READY_TICKS,
    STEPS_PER_TILE,
    MAX_PLAYERS,
    START_LIVES,
    POWER_RESPAWN_TICKS,
  };
});
