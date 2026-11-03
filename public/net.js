// Peer-to-peer networking for Pacmates. No game server is needed:
// - The host's browser runs the authoritative GameRoom from engine.js and registers the PeerJS
//   id `pacmates-v1-<ROOMCODE>`, so the 4-letter room code is all mates need to connect.
// - Joiners open a WebRTC data channel to the host and only send input; the host streams state back.
// The API mirrors the Socket.IO calls client.js used: net.on(event, fn) and net.emit(event, ...args, ack).
(function () {
  const PEER_PREFIX = 'pacmates-v1-';
  const CONNECT_TIMEOUT_MS = 12000;
  const { GameRoom, generateRoomCode } = window.PacmatesEngine;

  // Browsers throttle timers in background tabs to ~1/s; a worker timer keeps the host's game loop at full speed.
  function createTicker() {
    try {
      const src = 'let t=null;onmessage=(e)=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data);};';
      const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      let callback = null;
      worker.onmessage = () => callback && callback();
      return {
        setInterval(fn, ms) { callback = fn; worker.postMessage(ms); return 1; },
        clearInterval() { callback = null; worker.postMessage(0); },
        stop() { worker.terminate(); },
      };
    } catch {
      return {
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (id) => clearInterval(id),
        stop() {},
      };
    }
  }

  function createNet() {
    const handlers = {};
    let mode = null; // 'host' | 'client' | null
    let peer = null;
    let room = null;
    let ticker = null;
    let hostConn = null;
    let localId = null;
    const conns = new Map(); // host only: playerId -> DataConnection

    function dispatch(ev, data) {
      (handlers[ev] || []).forEach((fn) => fn(data));
    }

    function teardown() {
      const old = { peer, room, ticker, hostConn, conns: [...conns.values()] };
      mode = null;
      peer = null;
      room = null;
      ticker = null;
      hostConn = null;
      localId = null;
      conns.clear();
      if (old.room) old.room.destroy();
      if (old.ticker) old.ticker.stop();
      old.conns.forEach((c) => c.close());
      if (old.hostConn) old.hostConn.close();
      if (old.peer) old.peer.destroy();
    }

    // ---------- Host ----------

    // The host's own view gets a copy so the UI never mutates engine state.
    function deliverLocal(ev, data) {
      dispatch(ev, typeof structuredClone === 'function' ? structuredClone(data) : JSON.parse(JSON.stringify(data)));
    }

    function hostSend(id, ev, data) {
      if (id === localId) return deliverLocal(ev, data);
      const conn = conns.get(id);
      if (conn && conn.open) conn.send({ ev, data });
    }

    function hostBroadcast(ev, data) {
      deliverLocal(ev, data);
      conns.forEach((conn) => { if (conn.open) conn.send({ ev, data }); });
    }

    function acceptConnection(conn) {
      conn.on('data', (msg) => {
        if (!room || !msg || typeof msg !== 'object') return;
        const id = conn.peer;
        if (msg.ev === 'joinRoom') {
          const res = room.join(id);
          conn.send({ ack: msg.ack, res: res.ok ? { ok: true, ...res.payload } : res });
          if (res.ok) {
            conns.set(id, conn);
            room.announceJoin(id);
          } else {
            setTimeout(() => conn.close(), 500);
          }
          return;
        }
        if (!conns.has(id)) return;
        const args = Array.isArray(msg.args) ? msg.args : [];
        if (msg.ev === 'startGame') room.start(id);
        else if (msg.ev === 'input') room.input(id, args[0]);
        else if (msg.ev === 'leaveRoom') conn.close();
      });
      conn.on('close', () => {
        if (conns.get(conn.peer) !== conn) return;
        conns.delete(conn.peer);
        if (room) room.leave(conn.peer);
      });
      conn.on('error', (err) => console.warn('Player connection error', err));
    }

    function createRoom(ack, attempt = 0) {
      teardown();
      const code = generateRoomCode();
      const p = new Peer(PEER_PREFIX + code, { debug: 0 });
      peer = p;

      p.on('open', (id) => {
        if (peer !== p) return;
        mode = 'host';
        localId = id;
        ticker = createTicker();
        room = new GameRoom(code, {
          broadcast: hostBroadcast,
          send: hostSend,
          setInterval: ticker.setInterval,
          clearInterval: ticker.clearInterval,
        });
        const res = room.join(localId);
        ack({ ok: true, ...res.payload });
        room.announceJoin(localId);
      });
      p.on('connection', acceptConnection);
      // Losing the signalling server doesn't drop existing players; reconnect so new mates can still join.
      p.on('disconnected', () => { if (peer === p && !p.destroyed) p.reconnect(); });
      p.on('error', (err) => {
        if (peer !== p) return;
        if (mode === 'host') return console.warn('PeerJS error', err);
        if (err.type === 'unavailable-id' && attempt < 5) return createRoom(ack, attempt + 1);
        teardown();
        ack({ ok: false, error: `Couldn't create a room (${err.type || err.message}). Check your connection.` });
      });
    }

    // ---------- Client ----------

    function joinRoom(code, ack) {
      teardown();
      let settled = false;
      const p = new Peer({ debug: 0 });
      peer = p;

      const finish = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!res.ok) teardown();
        ack(res);
      };
      const timer = setTimeout(
        () => finish({ ok: false, error: "Couldn't reach that room. Check the code and try again." }),
        CONNECT_TIMEOUT_MS,
      );

      p.on('open', () => {
        if (peer !== p) return;
        const conn = p.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' });
        hostConn = conn;
        conn.on('open', () => conn.send({ ev: 'joinRoom', ack: 1 }));
        conn.on('data', (msg) => {
          if (!msg || typeof msg !== 'object') return;
          if (msg.ack) {
            if (msg.res && msg.res.ok) {
              mode = 'client';
              localId = p.id;
            }
            return finish(msg.res || { ok: false, error: 'Unexpected reply from host.' });
          }
          if (msg.ev && mode === 'client') dispatch(msg.ev, msg.data);
        });
        conn.on('close', () => {
          if (hostConn !== conn) return;
          const wasInRoom = mode === 'client';
          teardown();
          if (wasInRoom) dispatch('disconnect', 'The host left, so the room has closed.');
          else finish({ ok: false, error: 'The host closed the connection.' });
        });
      });
      p.on('error', (err) => {
        if (peer !== p) return;
        if (err.type === 'peer-unavailable') return finish({ ok: false, error: 'Room not found!' });
        if (mode === 'client') {
          teardown();
          dispatch('disconnect', 'Lost connection to the host.');
          return;
        }
        finish({ ok: false, error: `Couldn't connect (${err.type || err.message}).` });
      });
    }

    // ---------- Public API ----------

    function emit(ev, ...args) {
      const ack = typeof args[args.length - 1] === 'function' ? args.pop() : () => {};
      if (ev === 'createRoom') return createRoom(ack);
      if (ev === 'joinRoom') return joinRoom(String(args[0] || '').trim().toUpperCase(), ack);
      if (ev === 'leaveRoom') return teardown();

      if (mode === 'host' && room) {
        if (ev === 'startGame') room.start(localId);
        else if (ev === 'input') room.input(localId, args[0]);
      } else if (mode === 'client' && hostConn && hostConn.open) {
        hostConn.send({ ev, args });
      }
    }

    window.addEventListener('pagehide', teardown);

    return {
      on(ev, fn) {
        (handlers[ev] = handlers[ev] || []).push(fn);
      },
      emit,
      get isHost() {
        return mode === 'host';
      },
    };
  }

  window.PacmatesNet = { createNet };
})();
