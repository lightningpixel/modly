import sys

import bpy


def arguments():
    marker = sys.argv.index("--")
    values = sys.argv[marker + 1:]
    return values[0], values[1], int(values[2]) if len(values) > 2 else 64


output_path, palette, size = arguments()
colors = {
    "before": ((0.95, 0.08, 0.08, 1.0), (1.0, 0.8, 0.08, 1.0)),
    "after": ((0.02, 0.18, 1.0, 1.0), (0.02, 0.9, 0.65, 1.0)),
}
first, second = colors[palette]
tile = 8
pixels = []
for y in range(size):
    for x in range(size):
        pixels.extend(first if (x // tile + y // tile) % 2 == 0 else second)

image = bpy.data.images.new("paint", width=size, height=size, alpha=True)
image.pixels = pixels
image.filepath_raw = output_path
image.file_format = "PNG"
image.save()
