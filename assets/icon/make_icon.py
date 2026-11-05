"""Draws the Cameras icon (icon.png, 140x140 RGBA): a white UniFi-Protect-style bullet camera, dark glass front,
blue lens ring and LED, on its wall arm; glossy like the kit's other app icons. Drawn at 4x, then downsampled.
    uv run --with pillow python assets/icon/make_icon.py [out.png]"""
import math, sys
from PIL import Image, ImageChops, ImageDraw, ImageFilter

K = 4
S = 140 * K


def layer():
    return Image.new('RGBA', (S, S), (0, 0, 0, 0))


def grad(size, stops, angle=90):
    """a linear gradient (stops [(t, (r,g,b,a))]) over size, along angle (90: top to bottom)"""
    w, h = size
    g = Image.new('RGBA', (w, h))
    px = g.load()
    a = math.radians(angle); dx, dy = math.cos(a), math.sin(a)
    lo = min(0, w * dx) + min(0, h * dy); hi = max(0, w * dx) + max(0, h * dy)
    for y in range(h):
        for x in range(w):
            t = ((x * dx + y * dy) - lo) / (hi - lo)
            for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
                if t <= t1:
                    k = 0 if t1 == t0 else (t - t0) / (t1 - t0)
                    px[x, y] = tuple(int(c0[i] + (c1[i] - c0[i]) * max(0, min(1, k))) for i in range(4))
                    break
            else:
                px[x, y] = stops[-1][1]
    return g


def fill(dst, mask, paint):
    """paint (an image of S x S or a colour) through mask (L) onto dst"""
    if not isinstance(paint, Image.Image):
        paint = Image.new('RGBA', (S, S), paint)
    m = ImageChops.multiply(mask, paint.getchannel('A'))
    dst.paste(paint, (0, 0), m)


def shape(fn):
    m = Image.new('L', (S, S), 0)
    fn(ImageDraw.Draw(m))
    return m


def glow(mask, colour, radius):
    g = Image.new('RGBA', (S, S), colour)
    g.putalpha(mask.filter(ImageFilter.GaussianBlur(radius)))
    return g


def full_grad(stops, angle=90, box=None):
    x0, y0, x1, y1 = box or (0, 0, S, S)
    g = layer()
    g.paste(grad((x1 - x0, y1 - y0), stops, angle), (x0, y0))
    return g


def draw():
    out = layer()
    # the shadow under it all
    sh = shape(lambda d: d.ellipse((120, 470, 470, 520), fill=150))
    out.alpha_composite(glow(sh, (0, 0, 0, 255), 14))

    # the wall arm and its round base (behind the body)
    base = shape(lambda d: d.ellipse((300, 420, 450, 486), fill=255))
    fill(out, base, full_grad([(0, (250, 251, 253, 255)), (1, (160, 168, 178, 255))], 90, (300, 420, 450, 486)))
    rim = shape(lambda d: d.ellipse((300, 420, 450, 486), outline=255, width=5))
    fill(out, rim, (120, 128, 140, 255))
    top = shape(lambda d: d.ellipse((322, 424, 428, 462), fill=255))
    fill(out, top, full_grad([(0, (255, 255, 255, 255)), (1, (214, 219, 226, 255))], 90, (322, 424, 428, 462)))
    arm = shape(lambda d: d.polygon([(318, 300), (372, 300), (402, 446), (348, 446)], fill=255))
    fill(out, arm, full_grad([(0, (196, 203, 212, 255)), (0.45, (255, 255, 255, 255)), (1, (176, 184, 194, 255))], 0, (318, 300, 402, 446)))
    arm_edge = shape(lambda d: d.line([(318, 300), (348, 446)], fill=255, width=3))
    fill(out, arm_edge, (140, 148, 160, 200))

    # the body: a capsule, white glossy, drawn level then turned 14 degrees (looking down to the left)
    body = layer()
    cap = shape(lambda d: d.rounded_rectangle((110, 170, 480, 330), radius=80, fill=255))
    fill(body, cap, full_grad([(0, (255, 255, 255, 255)), (0.5, (238, 241, 245, 255)), (1, (170, 178, 190, 255))], 90, (110, 170, 480, 330)))
    # the far end in shade, a soft gloss band on top
    end = shape(lambda d: d.rounded_rectangle((380, 170, 480, 330), radius=80, fill=255))
    fill(body, ImageChops.multiply(cap, end), full_grad([(0, (0, 0, 0, 0)), (1, (60, 70, 85, 90))], 0, (380, 170, 480, 330)))
    gloss = shape(lambda d: d.rounded_rectangle((170, 184, 450, 222), radius=19, fill=255)).filter(ImageFilter.GaussianBlur(5))
    fill(body, gloss, (255, 255, 255, 230))
    edge = shape(lambda d: d.rounded_rectangle((110, 170, 480, 330), radius=80, outline=255, width=4))
    fill(body, edge, (130, 140, 154, 255))
    # the blue band where the front meets the body (UniFi's accent)
    band = shape(lambda d: d.ellipse((150, 172, 222, 328), outline=255, width=7))
    fill(body, ImageChops.multiply(band, cap), (40, 140, 255, 255))
    body.alpha_composite(glow(ImageChops.multiply(band, cap), (60, 160, 255, 255), 6))

    # the front: a dark bezel, black glass, the lens with its blue ring, a reflection and the status LED
    cx, cy = 150, 250
    bez = shape(lambda d: d.ellipse((cx - 66, cy - 82, cx + 66, cy + 82), fill=255))
    fill(body, bez, full_grad([(0, (78, 86, 98, 255)), (1, (18, 21, 26, 255))], 90, (cx - 66, cy - 82, cx + 66, cy + 82)))
    glass = shape(lambda d: d.ellipse((cx - 56, cy - 70, cx + 56, cy + 70), fill=255))
    fill(body, glass, full_grad([(0, (34, 44, 60, 255)), (0.55, (8, 11, 16, 255)), (1, (2, 3, 5, 255))], 70, (cx - 56, cy - 70, cx + 56, cy + 70)))
    ring = shape(lambda d: d.ellipse((cx - 33, cy - 37, cx + 33, cy + 37), outline=255, width=6))
    body.alpha_composite(glow(ring, (40, 150, 255, 255), 7))
    fill(body, ring, (70, 170, 255, 255))
    lens = shape(lambda d: d.ellipse((cx - 26, cy - 30, cx + 26, cy + 30), fill=255))
    fill(body, lens, full_grad([(0, (30, 70, 140, 255)), (0.5, (10, 24, 52, 255)), (1, (0, 0, 0, 255))], 60, (cx - 26, cy - 30, cx + 26, cy + 30)))
    pupil = shape(lambda d: d.ellipse((cx - 11, cy - 13, cx + 11, cy + 13), fill=255))
    fill(body, pupil, (0, 0, 0, 255))
    spark = shape(lambda d: d.ellipse((cx - 18, cy - 24, cx - 4, cy - 10), fill=255)).filter(ImageFilter.GaussianBlur(1.5))
    fill(body, spark, (220, 236, 255, 235))
    refl = shape(lambda d: d.chord((cx - 52, cy - 68, cx + 52, cy + 68), 200, 290, fill=255)).filter(ImageFilter.GaussianBlur(4))
    fill(body, ImageChops.multiply(refl, glass), (255, 255, 255, 70))
    led = shape(lambda d: d.ellipse((cx - 6, cy + 46, cx + 6, cy + 58), fill=255))
    body.alpha_composite(glow(led, (60, 170, 255, 255), 8))
    fill(body, led, (150, 210, 255, 255))

    body = body.rotate(-14, resample=Image.BICUBIC, center=(300, 250))
    body = body.transform((S, S), Image.AFFINE, (1, 0, 10, 0, 1, 18), resample=Image.BICUBIC)   # (up a little: the arm under it)
    out.alpha_composite(body)
    # centred in the square with the other icons' margin (their objects span ~116-124 of 140 px)
    box = out.getchannel('A').point(lambda v: 255 if v > 40 else 0).getbbox()
    obj = out.crop(box); k = min(116 * K / obj.width, 116 * K / obj.height)
    obj = obj.resize((round(obj.width * k), round(obj.height * k)), Image.LANCZOS)
    sq = layer(); sq.alpha_composite(obj, ((S - obj.width) // 2, (S - obj.height) // 2))
    return sq.resize((140, 140), Image.LANCZOS)


if __name__ == '__main__':
    draw().save(sys.argv[1] if len(sys.argv) > 1 else 'icon.png')
