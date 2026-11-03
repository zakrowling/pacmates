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
//   ' ' empty floor. A floor tile on the left/right edge is a tunnel that wraps to the other side.
//   1-4  spawn point for Player 1-4 (no dot)
// This is one half of the arena; buildWideLayout() places two copies side by side.
const HALF_LAYOUT = [
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
  ' ........#..#........ ',
  '#.###.##.#..#.##.###.#',
  '#...#............#...#',
  '###.#.#.######.#.#.###',
  '#o....#........#....o#',
  '#.#######.##.#######.#',
  '#.........##.........#',
  '#3#######....#######4#',
  '######################',
];

// Rows where the shared middle wall is opened so players and ghosts can cross between halves.
const MIDDLE_OPENINGS = [1, 5, 9, 13, 17, 19];

// Joins two copies of the half layout, sharing one wall column down the middle.
// Players 1 and 3 keep the left half's corners; players 2 and 4 take the right half's corners.
function buildWideLayout(half, openings) {
  return half.map((row, y) => {
    const left = row.slice(0, -1).replace(/[24]/g, '.');
    const right = row.slice(1).replace(/[13]/g, '.');
    const seam = openings.includes(y) ? '.' : row[row.length - 1];
    return left + seam + right;
  });
}

const MAZE_LAYOUT = buildWideLayout(HALF_LAYOUT, MIDDLE_OPENINGS);

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

  // Group touching G tiles into separate ghost houses. Each house's door is its first tile
  // that opens onto the floor; ghosts leave through it and return to it as eyes.
  const houses = [];
  const seen = new Set();
  for (const start of ghostHouse) {
    if (seen.has(`${start.x},${start.y}`)) continue;
    const tiles = [];
    const queue = [start];
    seen.add(`${start.x},${start.y}`);
    while (queue.length) {
      const t = queue.shift();
      tiles.push(t);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = { x: t.x + dx, y: t.y + dy };
        const key = `${n.x},${n.y}`;
        if (!seen.has(key) && walls[n.y] && walls[n.y][n.x] === TILE.HOUSE) {
          seen.add(key);
          queue.push(n);
        }
      }
    }
    tiles.sort((a, b) => a.y - b.y || a.x - b.x);
    let door = null;
    let exit = null;
    for (const t of tiles) {
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        if (!door && walls[t.y + dy] && walls[t.y + dy][t.x + dx] === TILE.FLOOR) {
          door = t;
          exit = { x: t.x + dx, y: t.y + dy };
        }
      }
    }
    if (!door) throw new Error(`Ghost house at ${start.x},${start.y} has no exit`);
    houses.push({ tiles, door, exit });
  }
  houses.sort((a, b) => a.door.x - b.door.x);

  const tunnelRows = [];
  walls.forEach((row, y) => {
    if (row[0] === TILE.FLOOR || row[width - 1] === TILE.FLOOR) {
      if (row[0] !== row[width - 1]) throw new Error(`Tunnel on row ${y} must be open on both sides`);
      tunnelRows.push(y);
    }
  });

  return { width, height, walls, dots, spawns, houses, tunnelRows };
}

return { HALF_LAYOUT, MAZE_LAYOUT, TILE, PELLET, parseMaze, buildWideLayout };
});
