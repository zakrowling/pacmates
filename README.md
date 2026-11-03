# Pacmates

Online multiplayer Pac-Man for up to 4 mates. Play it at **https://zakrowling.github.io/pacmates/**

- **Room codes**: the host creates a room and gets a 4-letter code (e.g. `WFTF`). Up to 3 friends join with that code. Friends can also join a game that's already running. They drop into a free corner without interrupting anyone.
- **Link rooms**: share a link like https://zakrowling.github.io/pacmates/mate and nobody needs a code. The first person to open it hosts and everyone else joins. If the host leaves, the next player takes over hosting (with the same name), so the room stays open while anyone is in it. Any 2–16 letters, numbers or dashes work as a room name. Link rooms keep the lobby simple: just the player boxes and a **Start game with X players** button. Code rooms also show the code and a copyable invite link.
- **Lobby**: 4 player slots, each with that player's Pac-Man and a random 4-letter name. Your slot is marked `(YOU)`. Any player can start the game.
- **Double-width arena**: two copies of the classic-style maze side by side (43×22 tiles), sharing a middle wall with six crossings, with one ghost house in the very centre. The half layout lives in [`public/maze.js`](public/maze.js); `buildWideLayout()` joins the copies and `CENTRE_HOUSE` is stamped in the middle.
- **4 spawn points**: Players 1–4 start in the outer corners of the arena. Each player's score panel sits in the matching corner.
- **Name bubbles**: each Pac-Man has its name floating above it in game. Yours is yellow with black text; everyone else's is black with white text.
- **Tunnels**: like the arcade, the middle-left and middle-right edges are joined, and a one-tile gap in the centre of the top and bottom walls joins those too. Go off one side and you come back on the other. Ghosts slow down in tunnels.
- **Ghosts**: they start together in the central house and leave one at a time. There are 4 ghosts for one player plus one per extra player (up to 7); someone joining mid-game brings the next ghost with them: red Blinky, pink Pinky, cyan Inky, orange Clyde, purple Sue, green Funky and grey Spunky (brown Tim is defined for an 8th). Each heads for its own patch of the maze, chases a different player, and has its own style: chasing, ambushing ahead, flanking, sneaking up from behind, wandering, patrolling or cutting players off.
- **Power pellets**: eating one of the 8 power pellets turns the ghosts blue for 6 seconds. While powered up you glow and can also eat other Pac-Men who aren't powered up; they go back to their corner without losing a life. Each ghost or player you eat in one power-up scores 200, 400, 800, then 1600 points.
- **Lives**: each player has 3 lives. After being caught you respawn in your corner and can't be caught for a moment. The game ends when the maze is cleared or everyone is out.

## How it works

There is no game server. Pacmates is peer-to-peer, so it runs on any static host, including GitHub Pages.

- The **host's browser** runs the game engine ([`public/engine.js`](public/engine.js)): positions, ghosts, scoring and a 30 FPS game loop. Other players only send their direction input, so their browsers can't move anyone or change scores.
- Players connect to the host over WebRTC using [PeerJS](https://peerjs.com/) ([`public/net.js`](public/net.js)). The room code maps to the host's PeerJS ID, and PeerJS's free cloud server only introduces players to each other. Game traffic goes directly between browsers.
- The game keeps running at full speed if the host's tab is in the background. If the host leaves, the remaining players hand hosting to the next player and reconnect. A game in progress goes back to the lobby, and the room closes when the last person leaves.
- Some browser pairs and networks can't connect directly (e.g. Firefox ↔ Chrome, phones on mobile data, strict work networks). For those, add a free relay (TURN) server: sign up at [Metered Open Relay](https://www.metered.ca/tools/openrelay/) (20 GB/month free) and paste your credentials URL into `turnCredentialsUrl` in [`public/config.js`](public/config.js). Game traffic stays end-to-end encrypted through the relay.

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
