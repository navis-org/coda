"""How much detail a neuroglancer section panel is showing — i.e. which mip arrived.

The companion to `probe-ng-chunks.mjs`, which keeps a screenshot per camera move.

**Detail, not darkness.** The first version of this measured how black the panel was, on the
reasoning that an unloaded tile is black. It is not: neuroglancer draws the coarsest mip it has
while the finer ones are on their way, and a coarse mip at this zoom is a grid of *flat grey
blocks* — one colour per chunk, chunk boundaries visible, no structure. That is what the reported
failure looks like, and a darkness measure reads it as a perfectly good picture (0.7% black,
exactly like a loaded one).

So this measures local variation: the mean absolute difference between neighbouring pixels.
Real EM at 5 nm a pixel is full of membrane, so it runs high; a flat block is near zero. The two
are an order of magnitude apart, which is why no threshold is argued for here — open the PNG and
the answer is obvious either way.
"""

import sys

from PIL import Image, ImageChops, ImageStat

# The layer bar and the position readout are chrome, not the picture.
TOP = 50

print(f"{'shot':<32} {'detail':>7} {'dark %':>8} {'mean':>6}")
for path in sys.argv[1:]:
    image = Image.open(path).convert("L")
    width, height = image.size
    panel = image.crop((0, TOP, width // 2, height))
    # Neighbouring-pixel difference, one pixel to the right.
    shifted = ImageChops.offset(panel, 1, 0).crop((1, 0, panel.width, panel.height))
    detail = ImageStat.Stat(ImageChops.difference(panel.crop((1, 0, panel.width, panel.height)), shifted)).mean[0]
    pixels = list(panel.getdata())
    dark = 100 * sum(1 for p in pixels if p < 24) / len(pixels)
    name = path.rsplit("/", 1)[-1]
    print(f"{name:<32} {detail:>7.2f} {dark:>7.1f}% {sum(pixels) / len(pixels):>6.1f}")
