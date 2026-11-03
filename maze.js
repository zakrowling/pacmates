// Maze configuration matrix.
//   #  wall
//   .  dot
//   ' ' empty floor
//   1-4  spawn point for Player 1-4 (no dot)
const MAZE_LAYOUT = [
  '######################',
  '#1....#........#....2#',
  '#.###.#.######.#.###.#',
  '#.#................#.#',
  '#.#.##.###..###.##.#.#',
  '#......#......#......#',
  '###.##.#.####.#.##.###',
  '#........#..#........#',
  '#.####.#.#..#.#.####.#',
  '#......#......#......#',
  '#.##.#.###..###.#.##.#',
  '#..#.#..........#.#..#',
  '##.#.###.####.###.#.##',
  '#........#..#........#',
  '#.###.##.#..#.##.###.#',
  '#...#............#...#',
  '###.#.#.######.#.#.###',
  '#.....#........#.....#',
  '#.#######.##.#######.#',
  '#.........##.........#',
  '#3#######....#######4#',
  '######################',
];

const TILE = { WALL: 1, FLOOR: 0 };

function parseMaze(layout) {
  const height = layout.length;
  const width = layout[0].length;
  const walls = [];
  const dots = [];
  const spawns = [];

  layout.forEach((row, y) => {
    if (row.length !== width) throw new Error(`Maze row ${y} has width ${row.length}, expected ${width}`);
    const wallRow = [];
    const dotRow = [];
    [...row].forEach((ch, x) => {
      wallRow.push(ch === '#' ? TILE.WALL : TILE.FLOOR);
      dotRow.push(ch === '.');
      if (/[1-4]/.test(ch)) spawns[Number(ch) - 1] = { x, y };
    });
    walls.push(wallRow);
    dots.push(dotRow);
  });

  for (let i = 0; i < 4; i++) {
    if (!spawns[i]) throw new Error(`Maze is missing spawn point ${i + 1}`);
  }

  return { width, height, walls, dots, spawns };
}

module.exports = { MAZE_LAYOUT, TILE, parseMaze };
