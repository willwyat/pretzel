/**
 * Original 16×16 pixel-art chess sprites in the chunky Windows 3.x style.
 * Symmetrical pieces store the left 8 columns (mirrored when expanded); the
 * bishop (slanted slit) and knight are stored in full.
 * '#' outline, 'o' body, 'w' highlight, '.' transparent.
 */
export type PieceType = "p" | "n" | "b" | "r" | "q" | "k";

const HALF: Record<"p" | "r" | "q" | "k", string[]> = {
  p: [
    "........",
    "........",
    "........",
    "......##",
    ".....#oo",
    "....#owo",
    "....#ooo",
    ".....#oo",
    "....####",
    ".....#oo",
    ".....#ow",
    "....#ooo",
    "...#oooo",
    "..######",
    "..#ooooo",
    "..######",
  ],
  r: [
    "........",
    "........",
    ".###.###",
    ".#o#.#oo",
    ".#o###oo",
    ".#oooooo",
    ".#######",
    "...#owoo",
    "...#owoo",
    "...#owoo",
    "...#oooo",
    "..######",
    "..#ooooo",
    ".#######",
    ".#oooooo",
    ".#######",
  ],
  q: [
    "........",
    "#....##.",
    "##..#oo#",
    "#o#.#oo#",
    ".#o##oo#",
    ".#oooooo",
    ".#oowooo",
    "..#ooooo",
    "..######",
    "...#owoo",
    "...#owoo",
    "..#ooooo",
    ".#######",
    ".#oooooo",
    ".#oooooo",
    ".#######",
  ],
  k: [
    ".......#",
    ".....###",
    ".......#",
    "..###.##",
    ".#ooo###",
    "#oooo#oo",
    "#oowooo#",
    ".#oooooo",
    "..#ooooo",
    "..######",
    "...#owoo",
    "...#owoo",
    ".#######",
    ".#oooooo",
    ".#oooooo",
    ".#######",
  ],
};

const BISHOP: string[] = [
  ".......##.......",
  "......#oo#......",
  ".....#oooo#.....",
  "....#oooo#o#....",
  "...#oooo#ooo#...",
  "...#owo#oooo#...",
  "...#owoooooo#...",
  "....#oooooo#....",
  ".....#oooo#.....",
  "....########....",
  "......#oo#......",
  ".....#owoo#.....",
  "....#oooooo#....",
  "..############..",
  "..#oooooooooo#..",
  "..############..",
];

const KNIGHT: string[] = [
  "................",
  "......#..#......",
  ".....#o##o#.....",
  "....#oooooo#....",
  "...#oo#ooooo#...",
  "..#oooooooowo#..",
  ".#ooooooooowo#..",
  ".#oooo##oooowo#.",
  "..####.#ooowoo#.",
  "......#ooowooo#.",
  ".....#ooowoooo#.",
  "....#oooooooo#..",
  "....#oooooooo#..",
  "..############..",
  "..#oooooooooo#..",
  "..############..",
];

function mirror(rows: string[]): string[] {
  return rows.map((r) => r + [...r].reverse().join(""));
}

export const SPRITES: Record<PieceType, string[]> = {
  p: mirror(HALF.p),
  n: KNIGHT,
  b: BISHOP,
  r: mirror(HALF.r),
  q: mirror(HALF.q),
  k: mirror(HALF.k),
};
