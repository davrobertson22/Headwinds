"""Cut the self-hosted satellite basemap: public/tiles/bluemarble/{z}/{x}/{y}.jpg

Source: NASA Blue Marble Next Generation, July 2004, 21600x10800 (public domain)
  https://eoimages.gsfc.nasa.gov/images/imagerecords/74000/74092/world.200407.3x21600x10800.jpg
  (visibleearth.nasa.gov/images/74092 - the plain-ocean version, no bathymetry)

The source is equirectangular (plate carree); map tiles are Web Mercator. Longitude
maps linearly in both, so each zoom level resizes the source to the tile-grid
width once, then resamples rows by Mercator latitude (bilinear). The source is
kept at up to 2x the grid's height first, because Mercator stretches the poles
and a source downsampled to W x W/2 goes blocky there.

z0-6 = 5,461 tiles, ~21 MB at quality 78. z6 (16384 px around) is the last level
the 21600 px source can fill; the maps over-zoom past it (mapCore.js).

Usage (needs Pillow + numpy):
  python3 tools/bluemarble-tiles.py world.200407.3x21600x10800.jpg public/tiles/bluemarble 6 78
"""
import sys, os, math
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None


def main(src_path, out_dir, maxz, quality):
    src = Image.open(src_path).convert('RGB')
    T = 256
    total = 0
    for z in range(maxz + 1):
        W = T * (1 << z)
        eq = np.asarray(src.resize((W, min(src.size[1], W * 2)), Image.LANCZOS))
        H = eq.shape[0]
        n = 1 << z
        for ty in range(n):
            py = (np.arange(ty * T, (ty + 1) * T) + 0.5) / W
            lat = np.degrees(np.arctan(np.sinh(math.pi * (1 - 2 * py))))
            r = np.clip((90 - lat) / 180 * H - 0.5, 0, H - 1)
            r0 = np.floor(r).astype(int)
            r1 = np.minimum(r0 + 1, H - 1)
            f = (r - r0)[:, None, None]
            strip = eq[r0].astype(np.float32) * (1 - f) + eq[r1].astype(np.float32) * f
            strip = np.clip(strip + 0.5, 0, 255).astype(np.uint8)
            for tx in range(n):
                d = os.path.join(out_dir, str(z), str(tx))
                os.makedirs(d, exist_ok=True)
                p = os.path.join(d, f'{ty}.jpg')
                Image.fromarray(strip[:, tx * T:(tx + 1) * T]).save(p, quality=quality, optimize=True, progressive=True)
                total += os.path.getsize(p)
        print(z, n * n, 'tiles', round(total / 1e6, 1), 'MB cumulative', flush=True)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))
