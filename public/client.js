(() => {
  const socket = io();

  // Asset layout matches github.com/bhattaraib58/Pacman-2Player (image/, audio/, font/).
  const ASSET_PATHS = {
    tiles: 'assets/image/pacman-tiles.png',
    sprites: 'assets/image/sprites32.png',
    audio: {
      start: 'assets/audio/opening_song.mp3',
      eat: 'assets/audio/eating.short.mp3',
      end: 'assets/audio/intermission.mp3',
    },
  };
  const TILE_SHEET_CELL = 16;
  const DOT_TILE_INDEX = 37;
  const SPRITE_CELL = 32;
  const PACMAN_FRAMES = {
    right: [0, 1, 2, 1],
    left: [4, 3, 2, 3],
    up: [5, 6, 2, 6],
    down: [7, 8, 2, 8],
  };
  const ANIMATION_FRAME_MS = 60;

  const TILE = 24;
  const SPRITE_SIZE = TILE * 1.5;
  const KEY_TO_DIR = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', s: 'down', a: 'left', d: 'right',
    W: 'up', S: 'down', A: 'left', D: 'right',
  };

  const $ = (id) => document.getElementById(id);
  const canvas = $('game-canvas');
  const ctx = canvas.getContext('2d');

  const state = {
    playerId: null,
    hostId: null,
    lobbyPlayers: [],
    maze: null,
    wallLayer: null,
    tickMs: 1000 / 30,
    prevPlayers: new Map(),
    currPlayers: new Map(),
    lastSnapshotAt: 0,
    playing: false,
    rafId: null,
  };

  const assets = { tiles: null, sprites: null, tintedPacman: new Map(), sounds: {} };

  function loadImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => {
        console.warn(`Missing asset: ${src}`);
        resolve(null);
      };
      img.src = src;
    });
  }

  async function loadAssets() {
    [assets.tiles, assets.sprites] = await Promise.all([loadImage(ASSET_PATHS.tiles), loadImage(ASSET_PATHS.sprites)]);
    for (const [key, src] of Object.entries(ASSET_PATHS.audio)) {
      const audio = new Audio(src);
      audio.preload = 'auto';
      audio.addEventListener('error', () => console.warn(`Missing asset: ${src}`));
      assets.sounds[key] = audio;
    }
  }

  function playSound(key, { restart = true } = {}) {
    const audio = assets.sounds[key];
    if (!audio || audio.error) return;
    if (!restart && !audio.paused) return;
    audio.currentTime = 0;
    audio.play().catch(() => {});
  }

  // Pac-Man in sprites32.png is yellow; recolour row 0 for the other players.
  function getPacmanSheet(color) {
    if (!assets.sprites) return null;
    if (color.toLowerCase() === '#ffff00') return { image: assets.sprites, row: 0 };
    if (!assets.tintedPacman.has(color)) {
      const off = document.createElement('canvas');
      off.width = assets.sprites.width;
      off.height = SPRITE_CELL;
      const octx = off.getContext('2d');
      octx.drawImage(assets.sprites, 0, 0, off.width, SPRITE_CELL, 0, 0, off.width, SPRITE_CELL);
      octx.globalCompositeOperation = 'source-atop';
      octx.fillStyle = color;
      octx.fillRect(0, 0, off.width, off.height);
      assets.tintedPacman.set(color, off);
    }
    return { image: assets.tintedPacman.get(color), row: 0 };
  }

  // ---------- Lobby UI ----------

  function showError(msg) {
    $('error-msg').textContent = msg || '';
  }

  function isHost() {
    return state.playerId && state.playerId === state.hostId;
  }

  function playerLabel(p) {
    return `${p.name}${p.id === state.playerId ? ' (YOU)' : ''}`;
  }

  const FACING_ANGLE = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 };

  // Draws a Pac-Man centred on (cx, cy) using the sprite sheet, or a vector fallback.
  function drawPacman(c, p, cx, cy, size, now) {
    const facing = p.facing || 'right';
    const frames = PACMAN_FRAMES[facing] || PACMAN_FRAMES.right;
    const step = Math.floor(now / ANIMATION_FRAME_MS);
    const sheet = getPacmanSheet(p.color);

    if (sheet) {
      const frame = p.moving ? frames[step % frames.length] : frames[1];
      c.drawImage(sheet.image, frame * SPRITE_CELL, sheet.row * SPRITE_CELL, SPRITE_CELL, SPRITE_CELL,
        cx - size / 2, cy - size / 2, size, size);
      return;
    }
    const mouth = p.moving ? [0.02, 0.12, 0.22, 0.12][step % 4] : 0.12;
    const base = FACING_ANGLE[facing];
    c.fillStyle = p.color;
    c.beginPath();
    c.moveTo(cx, cy);
    c.arc(cx, cy, size * 0.4, base + mouth * Math.PI, base + (2 - mouth) * Math.PI);
    c.closePath();
    c.fill();
  }

  // ---------- Lobby slots ----------

  const PREVIEW_PLAYER = { id: 'preview', number: 1, name: '', color: '#ffff00', facing: 'right', moving: true };

  function buildSlots() {
    $('slots').replaceChildren(...[1, 2, 3, 4].map((n) => {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.innerHTML = `<span class="slot-num">P${n}</span><canvas width="64" height="64"></canvas>`
        + '<span class="slot-name"></span><span class="slot-tag"></span>';
      return slot;
    }));
  }

  function slotPlayers() {
    if (!state.playerId) return [PREVIEW_PLAYER];
    return state.lobbyPlayers;
  }

  function renderSlots() {
    const players = slotPlayers();
    [...$('slots').children].forEach((slot, i) => {
      const p = players.find((pl) => pl.number === i + 1);
      const isYou = p && (p.id === state.playerId || p === PREVIEW_PLAYER);
      slot.classList.toggle('filled', !!p);
      slot.classList.toggle('you', !!isYou);
      slot.style.color = p ? p.color : '';
      slot.style.borderColor = p ? p.color : '';
      slot.querySelector('.slot-name').textContent = p ? (p.name || 'YOU') : 'EMPTY';
      let tag = '';
      if (p && p !== PREVIEW_PLAYER) tag = [isYou && '(YOU)', p.id === state.hostId && 'HOST'].filter(Boolean).join(' ');
      slot.querySelector('.slot-tag').textContent = tag;
    });
  }

  function animateSlots(now) {
    requestAnimationFrame(animateSlots);
    if ($('lobby-card').style.display === 'none') return;
    const players = slotPlayers();
    [...$('slots').children].forEach((slot, i) => {
      const c = slot.querySelector('canvas').getContext('2d');
      c.clearRect(0, 0, 64, 64);
      const p = players.find((pl) => pl.number === i + 1);
      if (p) drawPacman(c, { ...p, facing: 'right', moving: true }, 32, 32, 56, now + i * 90);
      else {
        c.strokeStyle = '#2a2a55';
        c.setLineDash([4, 4]);
        c.beginPath();
        c.arc(32, 32, 20, 0, Math.PI * 2);
        c.stroke();
      }
    });
  }

  function renderPlayerList(ul, players, rightText) {
    ul.replaceChildren(...players.map((p) => {
      const li = document.createElement('li');
      li.className = 'player-item';
      li.style.background = `${p.color}22`;
      li.style.color = p.color;
      const name = document.createElement('span');
      name.textContent = playerLabel(p);
      const right = document.createElement('span');
      right.textContent = rightText(p);
      li.append(name, right);
      return li;
    }));
  }

  function applyLobby(payload) {
    state.hostId = payload.hostId;
    state.lobbyPlayers = payload.players;
    $('setup-view').style.display = 'none';
    $('room-view').style.display = 'block';
    $('room-code-txt').textContent = payload.roomCode;
    $('player-count').textContent = payload.players.length;
    renderSlots();
    $('start-btn').style.display = isHost() ? 'block' : 'none';
    $('waiting-hint').style.display = isHost() ? 'none' : 'block';
    $('again-btn').style.display = isHost() ? 'block' : 'none';
    $('again-hint').style.display = isHost() ? 'none' : 'block';
  }

  function showLobby() {
    state.playing = false;
    $('game-view').style.display = 'none';
    $('game-over').style.display = 'none';
    $('lobby-card').style.display = 'block';
  }

  function resetToSetup() {
    state.playerId = null;
    state.hostId = null;
    state.lobbyPlayers = [];
    renderSlots();
    $('room-view').style.display = 'none';
    $('setup-view').style.display = 'block';
    showLobby();
  }

  function handleJoinResponse(res) {
    if (!res.ok) return showError(res.error);
    showError('');
    state.playerId = res.playerId;
    applyLobby(res);
  }

  $('create-btn').addEventListener('click', () => socket.emit('createRoom', handleJoinResponse));
  $('join-btn').addEventListener('click', () => {
    const code = $('room-input').value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) return showError('Enter a 4-letter room code.');
    socket.emit('joinRoom', code, handleJoinResponse);
  });
  $('room-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('join-btn').click();
  });
  $('start-btn').addEventListener('click', () => socket.emit('startGame'));
  $('again-btn').addEventListener('click', () => socket.emit('startGame'));
  $('leave-btn').addEventListener('click', () => {
    socket.emit('leaveRoom');
    resetToSetup();
  });
  $('exit-btn').addEventListener('click', showLobby);

  socket.on('lobbyUpdate', applyLobby);
  socket.on('disconnect', () => {
    resetToSetup();
    showError('Disconnected from server.');
  });

  // ---------- Game ----------

  function buildWallLayer(maze) {
    const layer = document.createElement('canvas');
    layer.width = maze.width * TILE;
    layer.height = maze.height * TILE;
    const lctx = layer.getContext('2d');
    const isWall = (x, y) => maze.walls[y] && maze.walls[y][x] === 1;
    const centre = (n) => n * TILE + TILE / 2;

    lctx.beginPath();
    for (let y = 0; y < maze.height; y++) {
      for (let x = 0; x < maze.width; x++) {
        if (!isWall(x, y)) continue;
        lctx.moveTo(centre(x), centre(y));
        lctx.lineTo(centre(x), centre(y));
        if (isWall(x + 1, y)) lctx.lineTo(centre(x + 1), centre(y));
        if (isWall(x, y + 1)) {
          lctx.moveTo(centre(x), centre(y));
          lctx.lineTo(centre(x), centre(y + 1));
        }
      }
    }
    lctx.lineCap = 'round';
    lctx.lineJoin = 'round';
    lctx.strokeStyle = '#2121de';
    lctx.lineWidth = TILE * 0.45;
    lctx.stroke();
    lctx.strokeStyle = '#000';
    lctx.lineWidth = TILE * 0.45 - 6;
    lctx.stroke();
    return layer;
  }

  function setupScoreboard(players) {
    $('scoreboard').replaceChildren(...players.map((p) => {
      const tag = document.createElement('div');
      tag.className = 'score-tag';
      tag.id = `score-${p.id}`;
      tag.style.borderLeft = `4px solid ${p.color}`;
      tag.style.color = p.color;
      tag.textContent = `${playerLabel(p)}: ${p.score}`;
      return tag;
    }));
  }

  function updateScoreboard(players) {
    players.forEach((p) => {
      const tag = $(`score-${p.id}`);
      if (tag) tag.textContent = `${playerLabel(p)}: ${p.score}`;
    });
    // Remove tags for players who left mid-game.
    const ids = new Set(players.map((p) => `score-${p.id}`));
    [...$('scoreboard').children].forEach((el) => { if (!ids.has(el.id)) el.remove(); });
  }

  socket.on('gameStarted', (payload) => {
    applyLobby(payload);
    state.maze = payload.maze;
    state.tickMs = 1000 / payload.tickRate;
    state.wallLayer = buildWallLayer(payload.maze);
    canvas.width = payload.maze.width * TILE;
    canvas.height = payload.maze.height * TILE;

    const players = new Map(payload.players.map((p) => [p.id, p]));
    state.prevPlayers = players;
    state.currPlayers = players;
    state.lastSnapshotAt = performance.now();
    state.playing = true;

    $('lobby-card').style.display = 'none';
    $('game-over').style.display = 'none';
    $('game-view').style.display = 'flex';
    setupScoreboard(payload.players);
    playSound('start');

    if (!state.rafId) state.rafId = requestAnimationFrame(render);
  });

  socket.on('state', (snapshot) => {
    if (!state.maze) return;
    state.prevPlayers = state.currPlayers;
    state.currPlayers = new Map(snapshot.players.map((p) => [p.id, p]));
    state.lastSnapshotAt = performance.now();

    snapshot.eaten.forEach(({ x, y, by }) => {
      state.maze.dots[y][x] = false;
      if (by === state.playerId) playSound('eat', { restart: false });
    });
    updateScoreboard(snapshot.players);
  });

  socket.on('gameOver', ({ standings }) => {
    state.playing = false;
    renderPlayerList($('standings'), standings, (p) => `${p.score}`);
    $('game-over').style.display = 'block';
    playSound('end');
  });

  window.addEventListener('keydown', (e) => {
    if (!state.playing) return;
    const dir = KEY_TO_DIR[e.key];
    if (!dir) return;
    e.preventDefault();
    if (!e.repeat) socket.emit('input', dir);
  });

  function drawDots(now) {
    const { maze } = state;
    const dotSx = (DOT_TILE_INDEX % TILE_SHEET_CELL) * TILE_SHEET_CELL;
    const dotSy = Math.floor(DOT_TILE_INDEX / TILE_SHEET_CELL) * TILE_SHEET_CELL;
    for (let y = 0; y < maze.height; y++) {
      for (let x = 0; x < maze.width; x++) {
        if (!maze.dots[y][x]) continue;
        if (assets.tiles) {
          ctx.drawImage(assets.tiles, dotSx, dotSy, TILE_SHEET_CELL, TILE_SHEET_CELL, x * TILE, y * TILE, TILE, TILE);
        } else {
          ctx.fillStyle = '#ffb8ae';
          ctx.fillRect(x * TILE + TILE / 2 - 2, y * TILE + TILE / 2 - 2, 4, 4);
        }
      }
    }
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function drawNameBubble(p, cx, top) {
    const isYou = p.id === state.playerId;
    ctx.font = '9px PacmanEmu, monospace';
    ctx.textBaseline = 'middle';
    const textW = ctx.measureText(p.name).width;
    const iconW = 10;
    const padX = 6;
    const w = padX * 2 + iconW + 4 + textW;
    const h = 16;
    const x = Math.max(1, Math.min(canvas.width - w - 1, cx - w / 2));
    const y = Math.max(1, top - h - 2);

    ctx.fillStyle = 'rgba(20, 20, 32, 0.85)';
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fill();
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 1;
    ctx.stroke();

    const iconX = x + padX + iconW / 2;
    const midY = y + h / 2;
    if (isYou) {
      ctx.fillStyle = '#ffe600';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('★', iconX, midY + 1);
    } else {
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(iconX, midY, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#fff';
    ctx.font = '9px PacmanEmu, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(p.name, x + padX + iconW + 4, midY + 1);
  }

  function drawPlayer(p, x, y, now) {
    const cx = x * TILE + TILE / 2;
    const cy = y * TILE + TILE / 2;
    drawPacman(ctx, p, cx, cy, SPRITE_SIZE, now);
  }

  // Server is authoritative; the client only interpolates between the last two snapshots.
  function render(now) {
    state.rafId = requestAnimationFrame(render);
    if (!state.maze || $('game-view').style.display === 'none') return;

    const alpha = Math.min(1, (now - state.lastSnapshotAt) / state.tickMs);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(state.wallLayer, 0, 0);
    drawDots(now);

    const positions = [];
    state.currPlayers.forEach((p) => {
      const prev = state.prevPlayers.get(p.id) || p;
      const jump = Math.abs(prev.x - p.x) + Math.abs(prev.y - p.y) > 1;
      const x = jump ? p.x : prev.x + (p.x - prev.x) * alpha;
      const y = jump ? p.y : prev.y + (p.y - prev.y) * alpha;
      drawPlayer(p, x, y, now);
      positions.push([p, x, y]);
    });
    // Bubbles go on top so a Pac-Man never covers another player's name.
    positions.forEach(([p, x, y]) => drawNameBubble(p, x * TILE + TILE / 2, y * TILE + TILE / 2 - SPRITE_SIZE / 2));
  }

  buildSlots();
  renderSlots();
  requestAnimationFrame(animateSlots);
  loadAssets();
})();
