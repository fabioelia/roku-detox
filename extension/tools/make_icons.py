#!/usr/bin/env python3
"""Draws the extension's toolbar icons (Python standard library only).

    python3 extension/tools/make_icons.py

Writes extension/icons/16.png, 48.png and 128.png: a dark #10161F rounded square,
a lighter TV outline with a stand, and a teal #66C5B1 check mark (the same look as
Detox Home's channel icon in roku-app/images). Transparent corners.
"""

import math
import os
import struct
import zlib

BG = (0x10, 0x16, 0x1F)
TV = (0x8A, 0x99, 0xAD)
TEAL = (0x66, 0xC5, 0xB1)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(os.path.dirname(HERE), "icons")
SAMPLES = 4  # supersampling per axis, for smooth edges


def sd_round_box(px, py, cx, cy, hw, hh, r):
    qx = abs(px - cx) - (hw - r)
    qy = abs(py - cy) - (hh - r)
    return math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - r


def sd_segment(px, py, ax, ay, bx, by):
    pax, pay, bax, bay = px - ax, py - ay, bx - ax, by - ay
    t = max(0.0, min(1.0, (pax * bax + pay * bay) / (bax * bax + bay * bay)))
    return math.hypot(pax - bax * t, pay - bay * t)


def shapes(size):
    """[(signed distance function in unit coordinates, color)] painted in order."""
    s = 1.0 / size
    simple = size <= 16
    out = [(lambda x, y: sd_round_box(x, y, 0.5, 0.5, 0.5, 0.5, 0.22), BG)]
    if not simple:
        stroke = max(0.045, 1.6 * s)
        # TV outline: a ring between two rounded boxes, plus a short stand.
        out.append((lambda x, y: abs(sd_round_box(x, y, 0.5, 0.45, 0.32, 0.22, 0.06)) - stroke / 2, TV))
        out.append((lambda x, y: sd_segment(x, y, 0.38, 0.79, 0.62, 0.79) - stroke / 2, TV))
    width = 0.11 if simple else max(0.07, 2.2 * s)
    cy = 0.5 if simple else 0.45
    scale = 1.25 if simple else 1.0
    a = (0.5 - 0.14 * scale, cy + 0.0 * scale)
    b = (0.5 - 0.03 * scale, cy + 0.10 * scale)
    c = (0.5 + 0.16 * scale, cy - 0.11 * scale)
    out.append((lambda x, y: min(sd_segment(x, y, *a, *b), sd_segment(x, y, *b, *c)) - width / 2, TEAL))
    return out


def render(size):
    layers = shapes(size)
    pixels = bytearray()
    for py in range(size):
        pixels.append(0)  # PNG filter: none
        for px in range(size):
            r = g = b = a = 0.0
            for sy in range(SAMPLES):
                for sx in range(SAMPLES):
                    x = (px + (sx + 0.5) / SAMPLES) / size
                    y = (py + (sy + 0.5) / SAMPLES) / size
                    color, alpha = (0.0, 0.0, 0.0), 0.0
                    for sdf, paint in layers:
                        if sdf(x, y) < 0:
                            color, alpha = paint, 1.0
                    r += color[0] * alpha
                    g += color[1] * alpha
                    b += color[2] * alpha
                    a += alpha
            n = SAMPLES * SAMPLES
            if a:
                pixels.extend((round(r / a), round(g / a), round(b / a), round(255 * a / n)))
            else:
                pixels.extend((0, 0, 0, 0))
    return bytes(pixels)


def png(size, raw):
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 48, 128):
        path = os.path.join(OUT_DIR, f"{size}.png")
        with open(path, "wb") as f:
            f.write(png(size, render(size)))
        print(f"Wrote {os.path.relpath(path)}")


if __name__ == "__main__":
    main()
