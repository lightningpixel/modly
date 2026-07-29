# Texture update proof

The installed Modly app stayed open throughout this proof. A separate test window
used the same file watcher, texture replacement, and visible status as the 3D
preview.

## Watched result

- `01-before.png`: watched frame before the save, with a red and yellow 64 x 64
  checker and `Watching paint.png` visible.
- `02-after.png`: watched frame after Blender saved a blue and green checker to
  the same file. The model, camera, and window did not reload.
- Measured time from the file save to the new texture being applied: **63 ms**.
- `04-recovered.png`: watched frame after restoring a valid file.

The square edges stayed crisp. The reload continues to use the nearest pixel for
both close and distant views and does not make softened copies.

## Visible failures

- `03-malformed.png`: the watched file was cut to 20 bytes. The old texture
  remained visible, while a red `Texture not updated` message explained that the
  file might still be saving or damaged.
- `05-wrong-size.png`: Blender saved a valid 32 x 32 image over the watched
  64 x 64 image. The old texture remained visible, while the message named both
  sizes and said to save at 64 x 64.

The watcher stayed active after both failures and accepted the next valid save.
