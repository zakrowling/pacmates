# Assets

Pacmates uses the same asset layout as [bhattaraib58/Pacman-2Player](https://github.com/bhattaraib58/Pacman-2Player). The files aren't included because that repo has no license and the artwork and sounds come from the original Namco game. Add your own copies here:

| Path | Used for |
|------|----------|
| `image/sprites32.png` | 32×32 cells. Row 0: Pac-Man (right `0,1`, left `4,3`, up `5,6`, down `7,8`, closed `2`). Row 1: death animation (`0`–`12`). Rows 2–5: Blinky, Pinky, Inky, Clyde (right `0,1`, down `2,3`, left `4,5`, up `6,7`). Row 6: eyes. Row 7: frightened (blue `0,1`, white `2,3`). Players 2–4 are recoloured automatically. |
| `image/pacman-tiles.png` | Dots (16×16 cells, dot = tile index 37). Power pellets are always drawn as glowing green circles. |
| `image/pacmates-logo.png` | Lobby title logo (included) |
| `image/pacman_icon.png` | Favicon |
| `audio/opening_song.mp3` | Game start |
| `audio/eating.short.mp3` | Eating a dot |
| `audio/eatpill.mp3` | Eating a power pellet |
| `audio/eatghost.mp3` | Eating a ghost |
| `audio/die.mp3` | Getting caught |
| `audio/intermission.mp3` | Game over |

If a file is missing, the game still runs, using vector graphics and synthesized sound effects instead.

The UI font is [Geist Pixel](https://fonts.google.com/specimen/Geist+Pixel), loaded from Google Fonts.
