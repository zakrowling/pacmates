# Pacmates

Online multiplayer Pac-Man for up to 4 mates. Play it at **https://zakrowling.github.io/pacmates/**

- **Room codes**: the host creates a room and gets a 4-letter code (e.g. `WFTF`). Up to 3 friends join with that code. Friends can also join a game that's already running. They drop into a free corner without interrupting anyone.
- **Lobby**: 4 player slots, each with that player's Pac-Man and a random 4-letter name. Your slot is marked `(YOU)`.
- **4 spawn points**: Players 1–4 start in the maze corners. The spawn points are set in the maze matrix in [`public/maze.js`](public/maze.js). Each player's score panel sits in the matching corner.
- **Name bubbles**: each Pac-Man has its name floating above it in game.
- **Ghosts**: Blinky, Pinky, Inky and Clyde leave the ghost house one at a time and use the arcade chase/scatter AI, targeting the nearest player.
- **Power pellets**: eating one of the 4 power pellets turns the ghosts blue for 6 seconds. Eat them for 200, 400, 800, then 1600 points.
- **Lives**: each player has 3 lives. After being caught you respawn in your corner and can't be caught for a moment. The game ends when the maze is cleared or everyone is out.

## How it works

There is no game server. Pacmates is peer-to-peer, so it runs on any static host, including GitHub Pages.

- The **host's browser** runs the game engine ([`public/engine.js`](public/engine.js)): positions, ghosts, scoring and a 30 FPS game loop. Other players only send their direction input, so their browsers can't move anyone or change scores.
- Players connect to the host over WebRTC using [PeerJS](https://peerjs.com/) ([`public/net.js`](public/net.js)). The room code maps to the host's PeerJS ID, and PeerJS's free cloud server only introduces players to each other. Game traffic goes directly between browsers.
- The host must keep their tab open. The game keeps running at full speed if the tab is in the background. If the host leaves, the room closes.
- On some strict corporate or mobile networks, browsers can't connect directly to each other (no TURN relay is configured). If a mate can't join, try another network.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000. To play locally, create a room in one browser window and join with the code from another window or device. An internet connection is still needed to reach the PeerJS service.

## Test

```bash
npm test
```

## Deploy

Every push to `main` runs the tests and publishes the `public/` folder to GitHub Pages ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)).

## Assets

Sprites and sounds are not included. See [`public/assets/README.md`](public/assets/README.md). Without them, the game uses vector graphics and synthesized sound effects.
