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
//   ' ' empty floor. A floor tile on an outer edge is a tunnel that wraps to the opposite edge
//       (left <-> right on the tunnel row, top <-> bottom in the centre column).
//   1-4  spawn point for Player 1-4 (no dot)
// This is one half of the arena; buildWideLayout() places two copies side by side and
// CENTRE_HOUSE is stamped over the middle so every ghost starts in one shared house.
const HALF_LAYOUT = [
  '######################',
  '#1....#........#....2#',
  '#.###.#.######.#.###.#',
  '#.#................#.#',
  '#.#.##.###..###.##.#.#',
  '#o.....#......#.....o#',
  '###.##.#.#..#.#.##.###',
  '#........#..#........#',
  '#.####.#.#..#.#.####.#',
  '#......#......#......#',
  '#.##.#.###..###.#.##.#',
  ' ..#.#..........#.#.. ',
  '##.#.###.#..#.###.#.##',
  '#........#..#........#',
  '#.###.##.#..#.##.###.#',
  '#...#............#...#',
  '#.#.#...#.##.#...#.#.#',
  '###.#.#.######.#.#.###',
  '#o....#........#....o#',
  '#.#######.##.#######.#',
  '#.........##.........#',
  '#3#######....#######4#',
  '######################',
];

// Rows where the shared middle wall is opened so players and ghosts can cross between halves.
const MIDDLE_OPENINGS = [1, 5, 9, 13, 18, 20];

// Central ghost house for all 8 ghosts (5x2 inside), with its door at the top and a corridor around it.
const CENTRE_HOUSE = [
  '.........',
  '.### ###.',
  '.#GGGGG#.',
  '.#GGGGG#.',
  '.#######.',
  '.........',
];
const CENTRE_HOUSE_TOP = 9;

function stampCentre(layout, block, top) {
  const left = Math.floor((layout[0].length - block[0].length) / 2);
  return layout.map((row, y) => {
    const b = block[y - top];
    return b === undefined ? row : row.slice(0, left) + b + row.slice(left + b.length);
  });
}

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

// Opens a one-tile vertical tunnel down the centre column: through the top and bottom walls,
// plus the bottom-row wall below the central corridor.
function openCentreColumn(layout) {
  const x = Math.floor(layout[0].length / 2);
  const last = layout.length - 1;
  const setAt = (row, ch) => row.slice(0, x) + ch + row.slice(x + 1);
  return layout.map((row, y) => {
    if (y === 0 || y === last) return setAt(row, ' ');
    if (y === last - 1 && row[x] === '#') return setAt(row, '.');
    return row;
  });
}

// Power pellets are placed across the whole arena (replacing the half layout's 'o's) so they're evenly spread.
const POWER_PELLETS = [
  [1, 5], [11, 5], [31, 5], [41, 5],
  [1, 18], [11, 18], [31, 18], [41, 18],
];

function placePowerPellets(layout, pellets) {
  return layout.map((row, y) => {
    let out = row.replace(/o/g, '.');
    for (const [x, py] of pellets) {
      if (py !== y) continue;
      if (out[x] !== '.') throw new Error(`Power pellet at ${x},${y} must be on a dot tile`);
      out = out.slice(0, x) + 'o' + out.slice(x + 1);
    }
    return out;
  });
}

const MAZE_LAYOUT = placePowerPellets(
  openCentreColumn(stampCentre(buildWideLayout(HALF_LAYOUT, MIDDLE_OPENINGS), CENTRE_HOUSE, CENTRE_HOUSE_TOP)),
  POWER_PELLETS,
);

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

  const tunnelCols = [];
  walls[0].forEach((t, x) => {
    if (t === TILE.FLOOR || walls[height - 1][x] === TILE.FLOOR) {
      if (t !== walls[height - 1][x]) throw new Error(`Tunnel in column ${x} must be open at top and bottom`);
      tunnelCols.push(x);
    }
  });

  return { width, height, walls, dots, spawns, houses, tunnelRows, tunnelCols };
}

return { HALF_LAYOUT, MAZE_LAYOUT, TILE, PELLET, parseMaze, buildWideLayout };
});
