#!/usr/bin/env python3
"""Draws the Detox Home channel icons and splash screen (Python standard library only).

    python3 tools/make_images.py

Writes images/icon_focus_hd.png (336x210), images/icon_focus_sd.png (248x140)
and images/splash_fhd.png (1920x1080): dark #10161F background, a lighter
rounded-rectangle "TV" outline with a stand, and a teal #66C5B1 check mark.
"""

import math
import os
import struct
import zlib

BG = (0x10, 0x16, 0x1F)
TV = (0x6B, 0x7B, 0x8F)
TEAL = (0x66, 0xC5, 0xB1)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(os.path.dirname(HERE), "images")


class Canvas:
    def __init__(self, width, height, color):
        self.w = width
        self.h = height
        self.px = bytearray(bytes(color) * (width * height))

    def blend(self, x, y, color, alpha):
        if alpha <= 0 or x < 0 or y < 0 or x >= self.w or y >= self.h:
            return
        if alpha > 1:
            alpha = 1.0
        i = (y * self.w + x) * 3
        for c in range(3):
            self.px[i + c] = int(round(self.px[i + c] * (1 - alpha) + color[c] * alpha))

    def shape(self, bbox, sdf, color):
        """Fills where the signed distance sdf(x, y) < 0, with 1px anti-aliasing."""
        x0, y0, x1, y1 = (int(math.floor(bbox[0])) - 2, int(math.floor(bbox[1])) - 2,
                          int(math.ceil(bbox[2])) + 2, int(math.ceil(bbox[3])) + 2)
        for y in range(max(0, y0), min(self.h, y1)):
            py = y + 0.5
            for x in range(max(0, x0), min(self.w, x1)):
                d = sdf(x + 0.5, py)
                if d < 0.5:
                    self.blend(x, y, color, 0.5 - d)

    def save_png(self, path):
        raw = bytearray()
        stride = self.w * 3
        for y in range(self.h):
            raw.append(0)  # filter: none
            raw.extend(self.px[y * stride:(y + 1) * stride])

        def chunk(kind, data):
            body = kind + data
            return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

        png = b"\x89PNG\r\n\x1a\n"
        png += chunk(b"IHDR", struct.pack(">IIBBBBB", self.w, self.h, 8, 2, 0, 0, 0))
        png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        png += chunk(b"IEND", b"")
        with open(path, "wb") as f:
            f.write(png)


def sd_round_box(px, py, cx, cy, hw, hh, r):
    qx = abs(px - cx) - (hw - r)
    qy = abs(py - cy) - (hh - r)
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    inside = min(max(qx, qy), 0.0)
    return outside + inside - r


def sd_segment(px, py, ax, ay, bx, by):
    pax, pay = px - ax, py - ay
    bax, bay = bx - ax, by - ay
    denom = bax * bax + bay * bay
    t = 0.0 if denom == 0 else max(0.0, min(1.0, (pax * bax + pay * bay) / denom))
    return math.hypot(pax - bax * t, pay - bay * t)


def draw_logo(cv, cx, cy, s):
    """TV outline + stand + check mark, centered on (cx, cy), s = scale (1.0 ~ 200px wide TV)."""
    hw, hh, r, stroke = 100 * s, 64 * s, 18 * s, 9 * s
    tv_cy = cy - 10 * s

    cv.shape((cx - hw - stroke, tv_cy - hh - stroke, cx + hw + stroke, tv_cy + hh + stroke),
             lambda x, y: abs(sd_round_box(x, y, cx, tv_cy, hw, hh, r)) - stroke / 2, TV)

    # Stand: short neck and a base bar.
    neck = (cx, tv_cy + hh, cx, tv_cy + hh + 14 * s)
    base = (cx - 38 * s, tv_cy + hh + 16 * s, cx + 38 * s, tv_cy + hh + 16 * s)
    for seg in (neck, base):
        ax, ay, bx, by = seg
        cv.shape((min(ax, bx) - stroke, min(ay, by) - stroke, max(ax, bx) + stroke, max(ay, by) + stroke),
                 lambda x, y, ax=ax, ay=ay, bx=bx, by=by: sd_segment(x, y, ax, ay, bx, by) - stroke / 2, TV)

    # Check mark inside the screen.
    p1 = (cx - 40 * s, tv_cy + 2 * s)
    p2 = (cx - 12 * s, tv_cy + 28 * s)
    p3 = (cx + 44 * s, tv_cy - 30 * s)
    thick = 15 * s
    cv.shape((p1[0] - thick, p3[1] - thick, p3[0] + thick, p2[1] + thick),
             lambda x, y: min(sd_segment(x, y, *p1, *p2), sd_segment(x, y, *p2, *p3)) - thick / 2, TEAL)


def make(name, width, height, scale):
    cv = Canvas(width, height, BG)
    draw_logo(cv, width / 2.0, height / 2.0, scale)
    path = os.path.join(OUT_DIR, name)
    cv.save_png(path)
    print("wrote", os.path.relpath(path, os.path.dirname(HERE)), "%dx%d" % (width, height))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    make("icon_focus_hd.png", 336, 210, 0.95)
    make("icon_focus_sd.png", 248, 140, 0.62)
    make("splash_fhd.png", 1920, 1080, 2.2)


if __name__ == "__main__":
    main()
