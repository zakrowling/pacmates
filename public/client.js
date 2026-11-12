(() => {
  const socket = window.PacmatesNet.createNet();

  // Asset layout matches github.com/bhattaraib58/Pacman-2Player (image/, audio/, font/).
  const ASSET_PATHS = {
    tiles: 'assets/image/pacman-tiles.png',
    sprites: 'assets/image/sprites32.png',
    audio: {
      start: 'assets/audio/pacman-theme.mp3', // played at the start of each round
      eat: 'assets/audio/eating.short.mp3',
      power: 'assets/audio/eatpill.mp3',
      eatGhost: 'assets/audio/eatghost.mp3',
      die: 'assets/audio/die.mp3',
      end: 'assets/audio/intermission.mp3',
    },
  };
  const TILE_SHEET_CELL = 16;
  const DOT_TILE_INDEX = 37;
  const POWER_PELLET_COLOR = '#39ff14';
  const SPRITE_CELL = 32;
  const PACMAN_DEATH_ROW = 1;
  const PACMAN_DEATH_FRAMES = 13;
  // Classic four use the sprite sheet rows when available; the extra four are always drawn as vectors.
  const GHOSTS = {
    blinky: { color: '#ff0000', row: 2 },
    pinky: { color: '#ffb8ff', row: 3 },
    inky: { color: '#00ffff', row: 4 },
    clyde: { color: '#ffb852', row: 5 },
    sue: { color: '#a35cff' },
    funky: { color: '#33dd66' },
    spunky: { color: '#b8b8c8' },
    tim: { color: '#c47a3a' },
  };
  const GHOST_FRAMES = { up: [6, 7], down: [2, 3], left: [4, 5], right: [0, 1] };
  const GHOST_EYES_ROW = 6;
  const GHOST_FRIGHTENED_ROW = 7;
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
    linkRoom: false, // entered via a link like /pacmates/mate: no room code UI
    lobbyPlayers: [],
    maze: null,
    wallLayer: null,
    tickMs: 1000 / 30,
    prevPlayers: new Map(),
    currPlayers: new Map(),
    prevGhosts: new Map(),
    currGhosts: new Map(),
    popups: [],
    lastEatSoundAt: 0,
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
      const audio = new Audio();
      audio.preload = 'auto';
      audio.addEventListener('canplaythrough', () => { audio.dataset.ready = '1'; }, { once: true });
      audio.addEventListener('error', () => console.info(`No ${src}; using synthesized sound`), { once: true });
      audio.src = src;
      assets.sounds[key] = audio;
    }
  }

  // ---------- Synthesized sound fallback (used when an audio file isn't in assets/) ----------

  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }
  // Browsers only allow audio after a user gesture.
  ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, getAudioCtx, { once: true }));

  function tone(ac, { type = 'square', from, to = from, start = 0, dur, vol = 0.08 }) {
    const t0 = ac.currentTime + start;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  let wakaToggle = false;
  const SYNTH = {
    eat(ac) {
      wakaToggle = !wakaToggle;
      tone(ac, { type: 'triangle', from: wakaToggle ? 480 : 260, to: wakaToggle ? 260 : 480, dur: 0.09, vol: 0.12 });
    },
    power(ac) {
      tone(ac, { from: 180, to: 900, dur: 0.35, vol: 0.06 });
    },
    eatGhost(ac) {
      tone(ac, { type: 'sawtooth', from: 150, to: 1600, dur: 0.22, vol: 0.06 });
    },
    die(ac) {
      for (let i = 0; i < 8; i++) tone(ac, { from: 900 - i * 90, to: 400 - i * 40, start: i * 0.13, dur: 0.12, vol: 0.07 });
      tone(ac, { from: 300, to: 60, start: 1.05, dur: 0.3, vol: 0.08 });
    },
    start(ac) {
      [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(ac, { from: f, start: i * 0.12, dur: 0.11, vol: 0.06 }));
    },
    end(ac) {
      [784, 659, 523, 392].forEach((f, i) => tone(ac, { type: 'triangle', from: f, start: i * 0.18, dur: 0.17, vol: 0.1 }));
    },
  };

  // Per-sound volume for the audio files (default full volume).
  const SOUND_VOLUME = { start: 0.5 };

  function playSound(key) {
    if (state.away) return;
    const audio = assets.sounds[key];
    if (audio && audio.dataset.ready && !audio.error) {
      const clip = audio.cloneNode();
      clip.volume = SOUND_VOLUME[key] ?? 1;
      clip.play().catch(() => {});
      return;
    }
    const ac = getAudioCtx();
    if (ac && SYNTH[key]) SYNTH[key](ac);
  }

  // Pac-Man in sprites32.png is yellow; recolour rows 0-1 (moving + death) for the other players.
  function getPacmanSheet(color) {
    if (!assets.sprites) return null;
    if (color.toLowerCase() === '#ffff00') return { image: assets.sprites, row: 0 };
    if (!assets.tintedPacman.has(color)) {
      const off = document.createElement('canvas');
      off.width = assets.sprites.width;
      off.height = SPRITE_CELL * 2;
      const octx = off.getContext('2d');
      octx.drawImage(assets.sprites, 0, 0, off.width, off.height, 0, 0, off.width, off.height);
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
    const dying = p.status === 'dead';

    if (sheet && dying) {
      const frame = Math.min(PACMAN_DEATH_FRAMES - 1, Math.floor(p.deathProgress * PACMAN_DEATH_FRAMES));
      c.drawImage(sheet.image, frame * SPRITE_CELL, PACMAN_DEATH_ROW * SPRITE_CELL, SPRITE_CELL, SPRITE_CELL,
        cx - size / 2, cy - size / 2, size, size);
      return;
    }
    if (sheet) {
      const frame = p.moving ? frames[step % frames.length] : frames[1];
      c.drawImage(sheet.image, frame * SPRITE_CELL, sheet.row * SPRITE_CELL, SPRITE_CELL, SPRITE_CELL,
        cx - size / 2, cy - size / 2, size, size);
      return;
    }
    let mouth = p.moving ? [0.02, 0.12, 0.22, 0.12][step % 4] : 0.12;
    let base = FACING_ANGLE[facing];
    if (dying) {
      mouth = 0.12 + 0.88 * p.deathProgress;
      base = FACING_ANGLE.up;
      if (mouth >= 0.99) return;
    }
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
      if (p && p !== PREVIEW_PLAYER) {
        tag = [isYou && '(YOU)', !state.linkRoom && p.id === state.hostId && 'HOST'].filter(Boolean).join(' ');
      }
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
    $('lobby-card').classList.toggle('link-room', state.linkRoom);
    renderSlots();
    // Any player can start.
    const count = payload.players.length;
    $('start-btn').textContent = `Start game with ${count} player${count === 1 ? '' : 's'}`;
    $('start-btn').style.display = 'block';
    $('room-code-txt').classList.toggle('long', payload.roomCode.length > 6);
    const link = shareLink(payload.roomCode);
    $('share-link').value = link;
    history.replaceState(null, '', `${basePath()}?room=${encodeURIComponent(payload.roomCode.toLowerCase())}`);
  }

  function showLobby() {
    state.playing = false;
    $('game-view').style.display = 'none';
    $('game-over').style.display = 'none';
    $('lobby-card').style.display = 'block';
    document.body.classList.remove('in-game');
  }

  // Directory the game is served from, e.g. "/pacmates/" on GitHub Pages or "/" locally.
  function basePath() {
    return location.pathname.replace(/[^/]*$/, '');
  }

  function shareLink(roomCode) {
    return `${location.origin}${basePath()}${roomCode.toLowerCase()}`;
  }

  function resetToSetup() {
    history.replaceState(null, '', basePath());
    state.linkRoom = false;
    $('lobby-card').classList.remove('link-room');
    state.playerId = null;
    state.hostId = null;
    state.lobbyPlayers = [];
    renderSlots();
    $('room-view').style.display = 'none';
    $('setup-view').style.display = 'block';
    showLobby();
  }

  function setConnecting(connecting) {
    $('create-btn').disabled = connecting;
    $('join-btn').disabled = connecting;
    if (connecting) showError('');
    $('connecting-hint').textContent = 'Connecting...';
    $('connecting-hint').style.display = connecting ? 'block' : 'none';
  }

  function handleJoinResponse(res) {
    setConnecting(false);
    if (!res.ok) {
      if (state.linkRoom || $('room-view').style.display === 'block') resetToSetup();
      return showError(res.error);
    }
    showError('');
    state.playerId = res.playerId;
    applyLobby(res);
  }

  $('create-btn').addEventListener('click', () => {
    setConnecting(true);
    socket.emit('createRoom', handleJoinResponse);
  });
  $('join-btn').addEventListener('click', () => {
    const code = $('room-input').value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) return showError('Enter a 4-letter room code.');
    setConnecting(true);
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

  // Home: just you back to the lobby screen, still in the room; the game carries on for everyone
  // else, without its sounds or game-over screen, and the next game brings you back in.
  $('game-home').addEventListener('click', () => {
    state.away = true;
    showLobby();
  });
  // Link rooms: leave and go back to the home screen to create or join a different room.
  $('home-btn').addEventListener('click', () => {
    socket.emit('leaveRoom');
    resetToSetup();
  });

  socket.on('lobbyUpdate', applyLobby);
  socket.on('disconnect', (reason) => {
    resetToSetup();
    showError(reason || 'Disconnected.');
  });
  // Progress through connection steps, so a stuck step is visible instead of a bare "Connecting...".
  socket.on('status', (text) => {
    if ($('connecting-hint').style.display === 'block') $('connecting-hint').textContent = text;
    if ($('reconnect-hint').style.display === 'block') $('reconnect-hint').textContent = text;
  });
  socket.on('reconnecting', (message) => {
    showLobby();
    $('start-btn').style.display = 'none';
    showError('');
    $('reconnect-hint').textContent = message;
    $('reconnect-hint').style.display = 'block';
  });
  socket.on('rejoined', (res) => {
    $('reconnect-hint').style.display = 'none';
    handleJoinResponse(res);
  });

  $('copy-btn').addEventListener('click', async () => {
    const input = $('share-link');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    $('copy-btn').textContent = 'Copied!';
    setTimeout(() => { $('copy-btn').textContent = 'Copy'; }, 1500);
  });


  // Apps that embed the game pass their own session id as ?group=<id> (any length or characters), so each
  // group gets its own link room instead of everyone sharing /mate. The id is hashed into a 4-letter code
  // like any other room (same letters, no I or O), so it can also be typed in to join.
  const GROUP_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  function groupRoom(id) {
    if (!id) return null;
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < id.length; i++) {
      const ch = id.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    let hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += GROUP_LETTERS[hash % GROUP_LETTERS.length];
      hash = Math.floor(hash / GROUP_LETTERS.length);
    }
    return code;
  }
  // Links like /pacmates/mate (or ?room=mate) open that room: join it if someone is hosting, otherwise host it.
  function enterRoomFromUrl() {
    const params = new URLSearchParams(location.search);
    const requested = params.get('room') || groupRoom(params.get('group'));
    if (!requested) return;
    if (!window.PacmatesNet.normaliseRoomName(requested)) {
      history.replaceState(null, '', basePath());
      return showError('Room names are 2-16 letters, numbers or dashes.');
    }
    state.linkRoom = true;
    $('lobby-card').classList.add('link-room');
    setConnecting(true);
    socket.emit('enterRoom', requested, handleJoinResponse);
  }

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

    // Ghost house doors: pink bar across the doorway between each house and its exit tile.
    lctx.strokeStyle = '#ffb8ff';
    lctx.lineWidth = 3;
    lctx.beginPath();
    maze.houses.forEach(({ door: d, exit: e }) => {
      if (e.y !== d.y) {
        const y = Math.max(d.y, e.y) * TILE;
        lctx.moveTo(d.x * TILE + 2, y);
        lctx.lineTo((d.x + 1) * TILE - 2, y);
      } else {
        const x = Math.max(d.x, e.x) * TILE;
        lctx.moveTo(x, d.y * TILE + 2);
        lctx.lineTo(x, (d.y + 1) * TILE - 2);
      }
    });
    lctx.stroke();
    return layer;
  }

  // One panel per spawn corner; a player's panel is chosen by their player number.
  function updateScoreboard(players) {
    document.querySelectorAll('.score-tag[data-slot]').forEach((tag) => {
      const p = players.find((pl) => pl.number === Number(tag.dataset.slot));
      tag.classList.toggle('empty', !p);
      if (!p) return;
      tag.classList.toggle('out', p.status === 'out');
      tag.style.color = p.color;
      if (!tag.firstChild) {
        tag.innerHTML = '<span class="tag-name"></span><span class="tag-score"></span><span class="tag-lives"></span>';
      }
      tag.querySelector('.tag-name').textContent = playerLabel(p);
      tag.querySelector('.tag-score').textContent = p.score;
      tag.querySelector('.tag-lives').textContent = p.status === 'out' ? 'OUT' : '♥'.repeat(Math.max(0, p.lives));
    });
  }

  socket.on('gameStarted', (payload) => {
    state.away = false;
    applyLobby(payload);
    state.maze = payload.maze;
    state.tickMs = 1000 / payload.tickRate;
    state.wallLayer = buildWallLayer(payload.maze);
    canvas.width = payload.maze.width * TILE;
    canvas.height = payload.maze.height * TILE;
    document.querySelectorAll('.hud').forEach((hud) => { hud.style.maxWidth = `${canvas.width}px`; });

    const players = new Map(payload.players.map((p) => [p.id, p]));
    state.prevPlayers = players;
    state.currPlayers = players;
    const ghosts = new Map(payload.ghosts.map((g) => [g.id, g]));
    state.prevGhosts = ghosts;
    state.currGhosts = ghosts;
    state.popups = [];
    state.readyTicks = payload.readyTicks || 0;
    state.readyAt = performance.now();
    state.lastSnapshotAt = performance.now();
    state.playing = true;

    $('lobby-card').style.display = 'none';
    $('game-over').style.display = 'none';
    $('game-view').style.display = 'flex';
    document.body.classList.add('in-game');
    updateScoreboard(payload.players);
    playSound('start');

    if (!state.rafId) state.rafId = requestAnimationFrame(render);
  });

  socket.on('state', (snapshot) => {
    if (!state.maze) return;
    state.prevPlayers = state.currPlayers;
    state.currPlayers = new Map(snapshot.players.map((p) => [p.id, p]));
    state.prevGhosts = state.currGhosts;
    state.currGhosts = new Map(snapshot.ghosts.map((g) => [g.id, g]));
    state.readyTicks = snapshot.readyTicks || 0;
    const now = performance.now();
    state.lastSnapshotAt = now;

    snapshot.events.forEach((ev) => {
      const mine = ev.by === state.playerId;
      if (ev.type === 'pelletRespawn') {
        state.maze.dots[ev.y][ev.x] = 2;
      } else if (ev.type === 'pellet') {
        state.maze.dots[ev.y][ev.x] = 0;
        if (mine && ev.power) playSound('power');
        else if (mine && now - state.lastEatSoundAt > 120) {
          state.lastEatSoundAt = now;
          playSound('eat');
        }
      } else if (ev.type === 'ghostEaten') {
        state.popups.push({ text: String(ev.points), x: ev.x, y: ev.y, until: now + 1000 });
        if (mine) playSound('eatGhost');
      } else if (ev.type === 'playerEaten') {
        state.popups.push({ text: String(ev.points), x: ev.x, y: ev.y, until: now + 1000 });
        if (mine) playSound('eatGhost');
        else if (ev.id === state.playerId) playSound('die');
      } else if (ev.type === 'death' && ev.id === state.playerId) {
        playSound('die');
      }
    });
    updateScoreboard(snapshot.players);
  });

  socket.on('gameOver', ({ standings, reason }) => {
    state.playing = false;
    if (state.away) return;
    $('game-over-title').textContent = reason === 'cleared' ? 'MAZE CLEARED!' : 'GAME OVER';
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
        const pellet = maze.dots[y][x];
        if (!pellet) continue;
        if (pellet === 2) {
          // Power pellets: neon green with a pulsing glow so they stand out from the dots.
          const pulse = 0.5 + 0.5 * Math.sin(now / 180);
          ctx.save();
          ctx.shadowColor = POWER_PELLET_COLOR;
          ctx.shadowBlur = 6 + 10 * pulse;
          ctx.fillStyle = POWER_PELLET_COLOR;
          ctx.beginPath();
          ctx.arc(x * TILE + TILE / 2, y * TILE + TILE / 2, TILE * (0.3 + 0.06 * pulse), 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          continue;
        }
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
    ctx.font = '10px "Geist Pixel", monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const w = ctx.measureText(p.name).width + 14;
    const h = 16;
    const x = Math.max(1, Math.min(canvas.width - w - 1, cx - w / 2));
    const y = Math.max(1, top - h - 2);

    // Your own bubble is yellow with black text so you can spot yourself; everyone else's is black.
    const isYou = p.id === state.playerId;
    ctx.fillStyle = isYou ? '#ffe600' : 'rgba(0, 0, 0, 0.85)';
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fill();
    ctx.fillStyle = isYou ? '#000' : '#fff';
    ctx.fillText(p.name, x + w / 2, y + h / 2 + 1);
  }

  function drawGhost(g, cx, cy, size, now) {
    const step = Math.floor(now / 150) % 2;
    const flashWhite = g.flashing && Math.floor(now / 200) % 2;

    if (assets.sprites && GHOSTS[g.kind].row !== undefined) {
      let row = GHOSTS[g.kind].row;
      let frame = GHOST_FRAMES[g.facing][step];
      if (g.eyes) {
        row = GHOST_EYES_ROW;
        frame = GHOST_FRAMES[g.facing][0];
      } else if (g.frightened) {
        row = GHOST_FRIGHTENED_ROW;
        frame = (flashWhite ? 2 : 0) + step;
      }
      ctx.drawImage(assets.sprites, frame * SPRITE_CELL, row * SPRITE_CELL, SPRITE_CELL, SPRITE_CELL,
        cx - size / 2, cy - size / 2, size, size);
      return;
    }

    const w = size * 0.8;
    const h = size * 0.8;
    const left = cx - w / 2;
    const top = cy - h / 2;
    if (!g.eyes) {
      ctx.fillStyle = g.frightened ? (flashWhite ? '#ffffff' : '#2121ff') : GHOSTS[g.kind].color;
      ctx.beginPath();
      ctx.arc(cx, top + w / 2, w / 2, Math.PI, 0);
      const zig = 6;
      for (let i = 0; i <= zig; i++) {
        const zx = left + w - (i * w) / zig;
        const zy = top + h - ((i + step) % 2 ? h * 0.14 : 0);
        ctx.lineTo(zx, zy);
      }
      ctx.closePath();
      ctx.fill();
    }

    if (g.frightened && !g.eyes) {
      const face = flashWhite ? '#ff0000' : '#ffb8ae';
      ctx.fillStyle = face;
      ctx.fillRect(cx - w * 0.22, top + h * 0.35, w * 0.12, w * 0.12);
      ctx.fillRect(cx + w * 0.1, top + h * 0.35, w * 0.12, w * 0.12);
      ctx.strokeStyle = face;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i <= 6; i++) {
        const mx = cx - w * 0.3 + (i * w * 0.6) / 6;
        const my = top + h * 0.68 + (i % 2 ? -2 : 2);
        if (i === 0) ctx.moveTo(mx, my);
        else ctx.lineTo(mx, my);
      }
      ctx.stroke();
      return;
    }

    const look = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[g.facing] || [0, 0];
    [-1, 1].forEach((side) => {
      const ex = cx + side * w * 0.2;
      const ey = top + h * 0.38;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(ex + look[0] * 1.5, ey + look[1] * 1.5, w * 0.13, w * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#2121de';
      ctx.beginPath();
      ctx.arc(ex + look[0] * w * 0.07, ey + look[1] * w * 0.08, w * 0.07, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // Shortest signed step from a to b on a wrapping axis of the given size.
  function wrapDelta(a, b, size) {
    let d = b - a;
    if (d > size / 2) d -= size;
    else if (d < -size / 2) d += size;
    return d;
  }

  function lerpEntity(prev, curr, alpha) {
    if (!prev) return [curr.x, curr.y];
    const { width: w, height: h } = state.maze;
    // Crossing a tunnel jumps from one edge to the other; interpolate the short way round instead.
    const dx = wrapDelta(prev.x, curr.x, w);
    const dy = wrapDelta(prev.y, curr.y, h);
    if (Math.abs(dx) + Math.abs(dy) > 1) return [curr.x, curr.y];
    const x = prev.x + dx * alpha;
    const y = prev.y + dy * alpha;
    return [((x % w) + w) % w, ((y % h) + h) % h];
  }

  // Draws an entity, plus copies on the far edges while it's partway through a tunnel.
  function drawWrapped(x, y, draw) {
    const { width: w, height: h } = state.maze;
    const xs = [x];
    const ys = [y];
    if (x > w - 1) xs.push(x - w);
    if (y > h - 1) ys.push(y - h);
    xs.forEach((wx) => ys.forEach((wy) => draw(wx, wy)));
  }

  function drawPlayer(p, x, y, now) {
    const cx = x * TILE + TILE / 2;
    const cy = y * TILE + TILE / 2;
    // Flicker while invulnerable after respawning.
    ctx.globalAlpha = p.invulnerable && Math.floor(now / 100) % 2 ? 0.35 : 1;
    // Powered-up players get a soft glow in their own colour (flashing near the end) so others know to run.
    if (p.powered && p.status === 'alive') {
      const flashOff = p.poweredFlashing && Math.floor(now / 150) % 2;
      ctx.shadowColor = flashOff ? 'transparent' : `${p.color}99`;
      ctx.shadowBlur = 8;
    }
    drawPacman(ctx, p, cx, cy, SPRITE_SIZE, now);
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.globalAlpha = 1;
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

    // While "Ready?" is up the board is frozen: ghosts and Pac-Men hold their animation frame.
    const animNow = state.readyTicks > 0 ? state.readyAt : now;

    const positions = [];
    state.currPlayers.forEach((p) => {
      if (p.status === 'out') return;
      const [x, y] = lerpEntity(state.prevPlayers.get(p.id), p, alpha);
      drawWrapped(x, y, (wx, wy) => drawPlayer(p, wx, wy, animNow));
      positions.push([p, x, y]);
    });

    state.currGhosts.forEach((g) => {
      const [x, y] = lerpEntity(state.prevGhosts.get(g.id), g, alpha);
      drawWrapped(x, y, (wx, wy) => drawGhost(g, wx * TILE + TILE / 2, wy * TILE + TILE / 2, SPRITE_SIZE, animNow));
    });

    const clock = performance.now();
    state.popups = state.popups.filter((pop) => pop.until > clock);
    ctx.font = '13px "Geist Pixel", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#00ffff';
    state.popups.forEach((pop) => ctx.fillText(pop.text, pop.x * TILE + TILE / 2, pop.y * TILE + TILE / 2));

    // Bubbles go on top so a Pac-Man never covers another player's name.
    positions.forEach(([p, x, y]) => drawNameBubble(p, x * TILE + TILE / 2, y * TILE + TILE / 2 - SPRITE_SIZE / 2));

    if (state.readyTicks > 0) drawReady();
  }

  // "Ready?" (just below the ghost house) while the round waits for the start jingle.
  function drawReady() {
    const house = state.maze.houses[0];
    const cx = canvas.width / 2;
    const cy = house ? (house.door.y + 3.5) * TILE : canvas.height / 2;
    ctx.save();
    ctx.font = '24px "Geist Pixel", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText('Ready?').width + 24;
    ctx.fillStyle = '#000';
    ctx.fillRect(cx - w / 2, cy - 16, w, 32);
    ctx.fillStyle = '#ffff00';
    ctx.fillText('Ready?', cx, cy + 1);
    ctx.restore();
  }

  buildSlots();
  renderSlots();
  enterRoomFromUrl();
  requestAnimationFrame(animateSlots);
  loadAssets();
})();
