// Shared by the browser (window.PacmatesMaze) and Node tests (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PacmatesMaze = factory();
})(typeof self !== 'undefined' ? self : this, () => {
// Maze configuration matrix.
//   #  wall
//   .  dot
//   o  power pellet (frightens ghosts)
//   G  ghost house (ghosts only)
//   ' ' empty floor
//   1-4  spawn point for Player 1-4 (no dot)
const MAZE_LAYOUT = [
  '######################',
  '#1....#........#....2#',
  '#.###.#.######.#.###.#',
  '#.#................#.#',
  '#.#.##.###..###.##.#.#',
  '#o.....#......#.....o#',
  '###.##.#.####.#.##.###',
  '#........#GG#........#',
  '#.####.#.#GG#.#.####.#',
  '#......#......#......#',
  '#.##.#.###..###.#.##.#',
  '#..#.#..........#.#..#',
  '##.#.###.####.###.#.##',
  '#........#..#........#',
  '#.###.##.#..#.##.###.#',
  '#...#............#...#',
  '###.#.#.######.#.#.###',
  '#o....#........#....o#',
  '#.#######.##.#######.#',
  '#.........##.........#',
  '#3#######....#######4#',
  '######################',
];

const TILE = { FLOOR: 0, WALL: 1, HOUSE: 2 };
const PELLET = { NONE: 0, DOT: 1, POWER: 2 };

function parseMaze(layout) {
  const height = layout.length;
  const width = layout[0].length;
  const walls = [];
  const dots = [];
  const spawns = [];
  const ghostHouse = [];

  layout.forEach((row, y) => {
    if (row.length !== width) throw new Error(`Maze row ${y} has width ${row.length}, expected ${width}`);
    const wallRow = [];
    const dotRow = [];
    [...row].forEach((ch, x) => {
      wallRow.push(ch === '#' ? TILE.WALL : ch === 'G' ? TILE.HOUSE : TILE.FLOOR);
      dotRow.push(ch === '.' ? PELLET.DOT : ch === 'o' ? PELLET.POWER : PELLET.NONE);
      if (/[1-4]/.test(ch)) spawns[Number(ch) - 1] = { x, y };
      if (ch === 'G') ghostHouse.push({ x, y });
    });
    walls.push(wallRow);
    dots.push(dotRow);
  });

  for (let i = 0; i < 4; i++) {
    if (!spawns[i]) throw new Error(`Maze is missing spawn point ${i + 1}`);
  }
  if (ghostHouse.length === 0) throw new Error('Maze is missing a ghost house (G)');

  // The house door is the first house tile that opens onto the floor; ghosts leave through it.
  let houseDoor = null;
  let houseExit = null;
  for (const t of ghostHouse) {
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      if (!houseDoor && walls[t.y + dy] && walls[t.y + dy][t.x + dx] === TILE.FLOOR) {
        houseDoor = t;
        houseExit = { x: t.x + dx, y: t.y + dy };
      }
    }
  }
  if (!houseDoor) throw new Error('Ghost house has no exit');

  return { width, height, walls, dots, spawns, ghostHouse, houseDoor, houseExit };
}

return { MAZE_LAYOUT, TILE, PELLET, parseMaze };
});
