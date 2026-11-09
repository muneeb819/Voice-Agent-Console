#!/usr/bin/env python3
"""Cut the flat backdrop out of the supplied MMA banners.

The operator-supplied JPEG masters live in brand-source/ and are not shipped as
browser assets. The console header must sit directly on the themed page, so this
removes only the backdrop that is *connected to the image border* and keeps every
interior pixel. A plain luminance key would also erase the dark chrome inside the
artwork.

Output: transparent WebP at the largest size the UI actually renders.
Requires Pillow + numpy (build-time only; not a runtime dependency).
"""
from __future__ import annotations

import argparse
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

# Pixels below this channel max are backdrop candidates. Connectivity to the
# border decides, so dark artwork enclosed by chrome is never removed.
BACKDROP_MAX = 46
TARGET_WIDTH = 800


def cut_backdrop(source: Path, target: Path, width: int = TARGET_WIDTH) -> tuple[int, int]:
    image = Image.open(source).convert('RGB')
    rgb = np.asarray(image)
    lum = rgb.astype(np.int16).max(axis=2)
    height, wide = lum.shape
    candidate = lum < BACKDROP_MAX

    seen = np.zeros((height, wide), bool)
    queue: deque[tuple[int, int]] = deque()
    for x in range(wide):
        for y in (0, height - 1):
            if candidate[y, x] and not seen[y, x]:
                seen[y, x] = True
                queue.append((y, x))
    for y in range(height):
        for x in (0, wide - 1):
            if candidate[y, x] and not seen[y, x]:
                seen[y, x] = True
                queue.append((y, x))
    while queue:
        y, x = queue.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < height and 0 <= nx < wide and candidate[ny, nx] and not seen[ny, nx]:
                seen[ny, nx] = True
                queue.append((ny, nx))

    hard = np.where(seen, 0, 255).astype(np.uint8)
    # Feather only the cut boundary so chrome does not alias on light themes.
    soft = np.asarray(Image.fromarray(hard, 'L').filter(ImageFilter.GaussianBlur(0.6))).astype(np.int16)
    alpha = np.where(seen, 0, np.clip(soft, 0, 255)).astype(np.uint8)

    out = Image.fromarray(np.dstack([rgb, alpha]), 'RGBA')
    if width and out.width > width:
        out = out.resize((width, round(out.height * width / out.width)), Image.LANCZOS)
    target.parent.mkdir(parents=True, exist_ok=True)
    out.save(target, 'WEBP', quality=90, method=6)
    return out.size


def verify_asset(source: Path, target: Path, width: int) -> bool:
    """Compare decoded pixels, not encoder bytes, so libwebp build differences
    do not fail CI. Also require a real alpha channel and a transparent cut."""
    import tempfile

    if not target.exists():
        return False
    with tempfile.TemporaryDirectory() as tmp:
        fresh = Path(tmp) / target.name
        cut_backdrop(source, fresh, width)
        with Image.open(fresh) as expected, Image.open(target) as actual:
            if actual.mode != 'RGBA' or actual.size != expected.size:
                return False
            expected_rgba = np.asarray(expected.convert('RGBA'))
            actual_rgba = np.asarray(actual.convert('RGBA'))
            if not np.array_equal(expected_rgba, actual_rgba):
                return False
            alpha = actual_rgba[..., 3]
            if alpha.min() != 0 or alpha.max() != 255:
                return False
            if float((alpha == 0).mean()) < 0.05:
                return False
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='verify committed assets match a fresh cut (pixel comparison)')
    parser.add_argument('--width', type=int, default=TARGET_WIDTH)
    args = parser.parse_args()

    root = Path(__file__).resolve().parent.parent
    source_dir = root / 'brand-source'
    target_dir = root / 'public' / 'assets' / 'brand'
    sources = sorted(source_dir.glob('*.jpg'))
    if not sources:
        raise SystemExit('No source banners found in brand-source/.')

    failures = []
    for source in sources:
        target = target_dir / f'{source.stem}.webp'
        if args.check:
            if not verify_asset(source, target, args.width):
                failures.append(target.name)
        else:
            size = cut_backdrop(source, target, args.width)
            print(f'{target.name}: {size[0]}x{size[1]} {target.stat().st_size} bytes')

    if args.check:
        if failures:
            raise SystemExit('Stale transparent brand assets: ' + ', '.join(failures))
        print(f'✓ {len(sources)} transparent brand assets match their source banners (RGBA pixels + alpha cut).')


if __name__ == '__main__':
    main()
