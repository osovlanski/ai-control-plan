"""Builds docs/demo/assets/demo-a-walkthrough.gif from the stills `pnpm demo:a`
produces. Needs Pillow (`pip install pillow`, a virtualenv is fine) and nothing
else; the repo has no runtime dependency on it.

    python3 docs/demo/make-walkthrough-gif.py
"""
from PIL import Image
import os
src = os.path.dirname(os.path.abspath(__file__)) + "/assets"
BG = (4, 7, 11)
# (still, bottom of its own content in cropped coordinates, hold ms)
plan = [("demo-a-1-k1-waiting.png", 900, 3500),
        ("demo-a-2-k2-quota-wait.png", 960, 4500),
        ("demo-a-3-k3-idle-probe.png", 760, 3500)]
# UI v2: the inspector column of the 1440px full-page still.
LEFT, TOP, RIGHT = 760, 318, 1420
H = max(p[1] for p in plan)
frames, durations = [], []
for name, bottom, hold in plan:
    im = Image.open(os.path.join(src, name)).convert("RGB")
    crop = im.crop((LEFT, TOP, min(RIGHT, im.width), min(TOP + bottom, im.height)))
    canvas = Image.new("RGB", (crop.width, H), BG)
    canvas.paste(crop, (0, 0))
    frames.append(canvas.convert("P", palette=Image.ADAPTIVE, colors=128))
    durations.append(hold)
out = os.path.join(src, "demo-a-walkthrough.gif")
frames[0].save(out, save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=True)
print(frames[0].width, "x", H, "->", os.path.getsize(out) // 1024, "KB")
