# Pacmates

Online multiplayer Pac-Man for up to 4 mates.

- **Room codes**: the host creates a room and gets a 4-letter code (e.g. `WFTF`). Up to 3 friends join with that code.
- **Lobby**: 4 player slots, each with that player's Pac-Man and a random 4-letter name. Your slot is marked `(YOU)`.
- **Server-authoritative**: player positions live on the server and update in a 30 FPS game loop. Clients only send direction input, so players can't desync or cheat.
- **4 spawn points**: Players 1–4 start in the maze corners. The spawn points are set in the maze matrix in [`maze.js`](maze.js).
- **Name bubbles**: each Pac-Man has its name floating above it in game.

## Run

```bash
npm install
npm start
```

Open http://localhost:3000 in up to 4 browsers or devices. Move with the arrow keys or WASD.

## Assets

Sprites, sounds and font are not included. See [`public/assets/README.md`](public/assets/README.md). Without them, the game falls back to vector graphics.
