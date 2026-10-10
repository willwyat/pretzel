#!/usr/bin/env python3
"""
Build the chess avatar sprite strips in remote-ui/public/avatars/chess/.

Usage (needs Pillow + NumPy, e.g. in a throwaway venv):
    python3 scripts/chess-avatars.py ~/Downloads/chess remote-ui/public/avatars/chess

Input: <n>_neutral.png plus <n>_{thinking,shocked,smug,victorious,loss}.jpeg per
character. They are pixel art that was upscaled (blurred, or JPEG at 2048 px),
so each image is put back on its native ~62-cell grid: find the cell size and
phase from edge energy, take the median colour of each cell's centre, repaint
the backdrop one exact colour, then quantize all six frames of a character to
one shared palette. Output: <n>.png, a 372×62 strip in EXPRESSIONS order (the
frame order must match remote-ui/src/lib/chessAvatars.ts).
"""
import os
import sys

import numpy as np
from PIL import Image

EXPRESSIONS = ["neutral", "thinking", "shocked", "smug", "victorious", "loss"]
CELLS = 62
COLOURS = 48


def fit_grid(edges, n):
    """Cell size and offset of the first cell edge, from a 1-D edge-energy profile."""
    p = edges - edges.mean()
    best = None
    for size in np.arange(n / 66, n / 59, n / 20000):
        z = (p * np.exp(2j * np.pi * np.arange(len(p)) / size)).sum()
        if best is None or abs(z) > best[0]:
            best = (abs(z), size, z)
    _, size, z = best
    return size, (-np.angle(z) / (2 * np.pi) * size) % size


def cell_centres(n, size, off):
    """CELLS centres on the fitted grid, centred on the image so every frame lines up."""
    k0 = round((n / 2 - off) / size - 0.5)
    return [off + (k0 + 0.5 + i - CELLS // 2) * size for i in range(CELLS)]


def degrid(path):
    a = np.asarray(Image.open(path).convert("RGB")).astype(float)
    n = a.shape[0]
    sx, ox = fit_grid(np.abs(np.diff(a, axis=1)).sum(axis=2).sum(axis=0), n)
    sy, oy = fit_grid(np.abs(np.diff(a, axis=0)).sum(axis=2).sum(axis=1), n)
    out = np.zeros((CELLS, CELLS, 3))
    for j, cy in enumerate(cell_centres(n, sy, oy)):
        for i, cx in enumerate(cell_centres(n, sx, ox)):
            y0, y1 = int(max(0, cy - 0.3 * sy)), int(min(n, cy + 0.3 * sy) + 1)
            x0, x1 = int(max(0, cx - 0.3 * sx)), int(min(n, cx + 0.3 * sx) + 1)
            block = a[y0:y1, x0:x1].reshape(-1, 3)
            out[j, i] = np.median(block, axis=0) if len(block) else a[min(n - 1, int(cy)), min(n - 1, int(cx))]
    return out


def border(img):
    return np.concatenate([img[0], img[-1], img[:, 0], img[:, -1]])


def repaint_backdrop(img, bg, tol=26):
    """Flood-fill the border-connected backdrop with one exact colour."""
    h, w, _ = img.shape
    near = np.abs(img - np.median(border(img), axis=0)).sum(axis=2) < tol
    seen = np.zeros((h, w), bool)
    stack = [(y, x) for y in range(h) for x in (0, w - 1)] + [(y, x) for x in range(w) for y in (0, h - 1)]
    while stack:
        y, x = stack.pop()
        if not (0 <= y < h and 0 <= x < w) or seen[y, x] or not near[y, x]:
            continue
        seen[y, x] = True
        stack += [(y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)]
    img[seen] = bg
    return img


def main(src, dst):
    os.makedirs(dst, exist_ok=True)
    bg = None
    for n in range(1, 100):
        files = [os.path.join(src, f"{n}_{e}.{'png' if e == 'neutral' else 'jpeg'}") for e in EXPRESSIONS]
        missing = [f for f in files if not os.path.exists(f)]
        if len(missing) == len(files):
            break
        if missing:
            sys.exit(f"character {n} is missing {', '.join(missing)}")
        frames = [degrid(f) for f in files]
        if bg is None:  # every character shares the first one's backdrop
            bg = np.round(np.median(border(frames[0]), axis=0))
        frames = [repaint_backdrop(f, bg) for f in frames]
        strip = Image.fromarray(np.clip(np.concatenate(frames, axis=1), 0, 255).astype(np.uint8))
        strip = strip.quantize(colors=COLOURS, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        strip.convert("RGB").save(os.path.join(dst, f"{n}.png"), optimize=True)
        print(f"{n}.png")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
