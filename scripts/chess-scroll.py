#!/usr/bin/env python3
"""
Build the pixel-art sprites for the chess scroll in remote-ui/public/sprites/scroll/.

Usage (standard library only):
    python3 scripts/chess-scroll.py remote-ui/public/sprites/scroll

Every sprite is drawn here as ASCII art, one character per art pixel, and
written as an SVG of crisp-edged rects, so CSS can scale it by any whole
number of CSS px (--px in chess.css) without blur. The paper edges and grain
are seeded noise, so reruns give the same files.

    roller-l / roller-mid / roller-r   top and bottom dowel: end cap, a tile
                                       that repeats along x, spiral end
    paper-edge-l / paper-edge-r        ragged paper edges, repeat along y
    paper-grain                        sparse stains and creases, repeats
    gems                               status gems, 4 frames: emerald, topaz,
                                       ruby, iron (chessStatus.ts TONE_GEM)
    sparkle                            twinkle over a lit gem
    hourglass                          clock icon, 4 frames of sand running
    rivet                              gold stud for frame corners
"""
import os
import random
import sys

PALETTE = {
    # parchment and wood (sampled from the reference scroll, plus an outline)
    "O": "#5a3418",
    "D": "#926040",
    "S": "#b98654",
    "M": "#d3a572",
    "P": "#e9c386",
    "H": "#f2dab3",
    # gold
    "Y": "#f2c14e",
    "y": "#a8701c",
    "W": "#fff6d6",
    # hourglass glass and sand
    "g": "#fbf3e0",
    "s": "#e0a43a",
}

GEMS = {
    "emerald": ("#9cf5a4", "#22a83a", "#0f5c1e"),
    "topaz": ("#ffd98a", "#f08a1c", "#9a4a08"),
    "ruby": ("#ff9a8a", "#d4261c", "#7a0c08"),
    "iron": ("#a8a29a", "#6a645e", "#3a3530"),
}

ROLLER_L = [
    "..OOOO",
    ".OSPPP",
    "OSMHHH",
    "OSMHHH",
    "OSMPPP",
    "OSMPPP",
    "OSSMMM",
    "OSSMMM",
    ".ODDDD",
    "..OOOO",
]

ROLLER_MID = [
    "OOOOOOOOOOOO",
    "PPPPPPPPPPPP",
    "HHHHHHHHHHHH",
    "HHHHPHHHHHHH",
    "PPPPPPPPPMPP",
    "PPMPPPPPPPPP",
    "MMMMMMSMMMMM",
    "MSMMMMMMMMSM",
    "DDDDDDDDDDDD",
    "OOOOOOOOOOOO",
]

# Rolled-up end: the paper's spiral seen end-on.
ROLLER_R = [
    "OOOOOOOO..",
    "PPOMPPPMO.",
    "HOMPOOOPMO",
    "HOPOMMMODO",
    "POPOMOOMDO",
    "POPODOMODO",
    "MOMODDODDO",
    "MOMMOOODDO",
    "DDODDDDDO.",
    "OOOOOOOO..",
]

GEM = [
    "..OOOOO..",
    ".OYYYYyO.",
    "OYWLLBByO",
    "OYLLBBdyO",
    "OYLBBBdyO",
    "OYBBBddyO",
    "OyBBdddyO",
    ".OyyyyyO.",
    "..OOOOO..",
]

SPARKLE = [
    "..W..",
    "..W..",
    "WWYWW",
    "..W..",
    "..W..",
]

RIVET = [
    ".OO.",
    "OWYO",
    "OYyO",
    ".OO.",
]

HOURGLASS = [
    "OOOOOOOOO",
    "ODDDDDDDO",
    ".OgggggO.",
    ".OgggggO.",
    "..OgggO..",
    "...OgO...",
    "...OgO...",
    "..OgggO..",
    ".OgggggO.",
    ".OgggggO.",
    "ODDDDDDDO",
    "OOOOOOOOO",
]


def hourglass_frames():
    """Four frames: full top, two draining (with a falling stream), full bottom."""
    top = [(5, 4), (4, 3), (4, 4), (4, 5)] + [(3, c) for c in range(2, 7)] + [(2, c) for c in range(2, 7)]
    bottom = [(9, c) for c in range(2, 7)] + [(8, c) for c in range(2, 7)] + [(7, 3), (7, 4), (7, 5), (6, 4)]
    n = len(top)
    frames = []
    for k in range(4):
        g = [list(r) for r in HOURGLASS]
        left = round(n * (3 - k) / 3)
        for r, c in top[:left]:
            g[r][c] = "s"
        for r, c in bottom[: n - left]:
            g[r][c] = "s"
        if k in (1, 2):  # stream through the neck
            g[6][4] = "s"
            for r in range(7, 10):
                if g[r][4] == "g":
                    g[r][4] = "s"
        frames.append(["".join(r) for r in g])
    return frames


def noise_edge(width, height, seed, mirror):
    """Ragged paper edge: outline column, then clustered dark/mid flecks fading inward."""
    rnd = random.Random(seed)
    cols = [["O"] * height]
    weights = [
        [("D", 6), ("S", 3), ("M", 1)],
        [("S", 3), ("M", 4), (".", 3)],
        [("M", 3), (".", 7)],
        [("M", 1), (".", 9)],
    ]
    for c in range(1, width):
        col = []
        while len(col) < height:
            pick = rnd.choices([v for v, _ in weights[c - 1]], [w for _, w in weights[c - 1]])[0]
            col += [pick] * rnd.randint(1, 4)
        cols.append(col[:height])
    rows = ["".join(cols[c][r] for c in range(width)) for r in range(height)]
    return [r[::-1] for r in rows] if mirror else rows


def grain(size, seed):
    """Sparse stains, a few creases and light flecks on clear paper."""
    rnd = random.Random(seed)
    g = [["."] * size for _ in range(size)]
    for _ in range(9):  # stains: small blobs
        x, y = rnd.randrange(size), rnd.randrange(size)
        for dx, dy in [(0, 0), (1, 0), (0, 1), (1, 1)][: rnd.randint(1, 4)]:
            g[(y + dy) % size][(x + dx) % size] = "M"
    for _ in range(4):  # creases: short stepped lines
        x, y = rnd.randrange(size), rnd.randrange(size)
        for i in range(rnd.randint(4, 9)):
            g[(y + i // 3) % size][(x + i) % size] = "M"
    for _ in range(10):
        g[rnd.randrange(size)][rnd.randrange(size)] = "H"
    return ["".join(r) for r in g]


def svg(frames, palette=PALETTE):
    """One SVG strip of equal-sized frames, laid out left to right."""
    h = len(frames[0])
    w = len(frames[0][0])
    paths = {}
    for f, grid in enumerate(frames):
        assert len(grid) == h and all(len(r) == w for r in grid), "ragged sprite"
        for y, row in enumerate(grid):
            x = 0
            while x < w:
                ch = row[x]
                end = x
                while end < w and row[end] == ch:
                    end += 1
                if ch != ".":
                    paths.setdefault(palette[ch], []).append(f"M{f * w + x} {y}h{end - x}v1h{x - end}z")
                x = end
    body = "".join(f'<path fill="{c}" d="{"".join(d)}"/>' for c, d in paths.items())
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w * len(frames)}" height="{h}" '
        f'viewBox="0 0 {w * len(frames)} {h}" shape-rendering="crispEdges">{body}</svg>\n'
    )


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)

    sprites = {
        "roller-l": svg([ROLLER_L]),
        "roller-mid": svg([ROLLER_MID]),
        "roller-r": svg([ROLLER_R]),
        "paper-edge-l": svg([noise_edge(5, 32, 11, mirror=False)]),
        "paper-edge-r": svg([noise_edge(4, 32, 23, mirror=True)]),
        "paper-grain": svg([grain(48, 5)]),
        "gems": gems_svg(),
        "sparkle": svg([SPARKLE]),
        "hourglass": svg(hourglass_frames()),
        "rivet": svg([RIVET]),
    }
    for name, text in sprites.items():
        with open(os.path.join(out, f"{name}.svg"), "w") as fh:
            fh.write(text)
        print(f"{name}.svg")


def gems_svg():
    """Gem strip: same mask, each frame with its own three stone colours."""
    w, h = len(GEM[0]), len(GEM)
    parts = []
    for f, name in enumerate(GEMS):
        light, base, dark = GEMS[name]
        palette = {**PALETTE, "L": light, "B": base, "d": dark}
        inner = svg([GEM], palette)
        body = inner[inner.index(">") + 1 : inner.rindex("</svg>")]
        parts.append(f'<g transform="translate({f * w} 0)">{body}</g>')
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w * len(GEMS)}" height="{h}" '
        f'viewBox="0 0 {w * len(GEMS)} {h}" shape-rendering="crispEdges">{"".join(parts)}</svg>\n'
    )


if __name__ == "__main__":
    main()
