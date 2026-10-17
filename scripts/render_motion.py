"""Compose continuous ambient motion behind rendered source pages, never re-typeset them."""
import json
import math
import os
import signal
import subprocess
import sys
from collections import deque
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def ease(value):
    value = max(0.0, min(1.0, value))
    return value * value * value * (value * (value * 6 - 15) + 10)


def prepare(file, backdrop_hint=None):
    image = Image.open(file).convert('RGB')
    data = np.asarray(image).astype(np.int16)
    corners = np.array([data[3, 3], data[3, -4], data[-4, 3], data[-4, -4]])
    base = np.median(corners, axis=0)
    # Remove only edge-connected flat backdrop. Photos and complex designs stay intact.
    near = np.max(np.abs(data - base), axis=2) <= 18
    can_separate = np.max(np.abs(corners - base)) <= 20 and np.mean(near) > .25
    foreground = image.convert('RGBA')
    alpha_fraction = 1.0
    if can_separate:
        # Pillow's grayscale flood fill does not reliably preserve an arbitrary
        # sentinel value when the image contains both 0 and 255 regions. Work
        # in a binary image and remove only edge-connected background pixels.
        background = Image.fromarray(near)
        for point in [(0, 0), (image.width - 1, 0), (0, image.height - 1), (image.width - 1, image.height - 1)]:
            if background.getpixel(point):
                ImageDraw.floodfill(background, point, 0, thresh=0)
        enclosed_near = np.asarray(background, dtype=bool)
        # Only PPTX pages with explicit safe native fills may clear large
        # enclosed backdrop regions. Unknown raster pages keep their occlusion.
        hole_mask = np.zeros_like(enclosed_near, dtype=bool)
        clear_holes = (backdrop_hint or {}).get('clearEnclosedBackground') is True
        expected_base = (backdrop_hint or {}).get('backgroundColor', [])
        clear_holes = clear_holes and len(expected_base) == 3 and np.max(np.abs(base - expected_base)) <= 8
        if clear_holes:
            minimum_area = max(2048, int(enclosed_near.size * .0025))
            pending = enclosed_near.copy()
            height, width = pending.shape
            while pending.any():
                seed = np.flatnonzero(pending)[0]
                sy, sx = divmod(int(seed), width)
                queue = deque([(sy, sx)])
                pending[sy, sx] = False
                points = []
                min_x = max_x = sx
                min_y = max_y = sy
                while queue:
                    y, x = queue.pop()
                    points.append((y, x))
                    min_x = min(min_x, x); max_x = max(max_x, x)
                    min_y = min(min_y, y); max_y = max(max_y, y)
                    for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                        if 0 <= ny < height and 0 <= nx < width and pending[ny, nx]:
                            pending[ny, nx] = False
                            queue.append((ny, nx))
                if len(points) >= minimum_area and max_x - min_x + 1 >= 32 and max_y - min_y + 1 >= 32:
                    for y, x in points:
                        hole_mask[y, x] = True
        alpha = np.where((~near) | (enclosed_near & ~hole_mask), 255, 0).astype(np.uint8)
        alpha_fraction = float(np.mean(alpha > 0))
        # A 0.3px edge softening prevents a keyed white halo, without softening source text.
        foreground.putalpha(Image.fromarray(alpha).filter(ImageFilter.GaussianBlur(.25)))
    return foreground, base, can_separate, alpha_fraction


def content_layers(foreground, separated):
    """Split only at empty corridors so no source pixel is cut or duplicated."""
    bounds = foreground.getbbox()
    if not bounds:
        return []
    if not separated:
        return [(foreground, 0, 0)]
    opacity = np.asarray(foreground.getchannel('A')) > 0
    boxes = [bounds]
    # Recursively divide sparse slides along whitespace, grouping adjacent text
    # lines together instead of treating individual letters as separate objects.
    for _ in range(15):
        candidates = []
        for index, (left, top, right, bottom) in enumerate(boxes):
            area = opacity[top:bottom, left:right]
            for axis, projection in [(0, area.any(axis=0)), (1, area.any(axis=1))]:
                occupied = np.flatnonzero(projection)
                for start, end in zip(occupied[:-1], occupied[1:]):
                    gap = int(end - start - 1)
                    if gap < 22:
                        continue
                    cut = (int(start) + int(end)) // 2
                    first = area[:, :cut] if axis == 0 else area[:cut, :]
                    second = area[:, cut:] if axis == 0 else area[cut:, :]
                    if first.sum() < 100 or second.sum() < 100:
                        continue
                    # A wide inter-column gap is a stronger boundary than the
                    # small spaces between body lines in the same paragraph.
                    score = gap * (1.15 if axis == 0 else 1)
                    candidates.append((score, index, axis, cut))
        if not candidates:
            break
        _, index, axis, cut = max(candidates)
        left, top, right, bottom = boxes.pop(index)
        if axis == 0:
            boxes.extend([(left, top, left + cut, bottom), (left + cut, top, right, bottom)])
        else:
            boxes.extend([(left, top, right, top + cut), (left, top + cut, right, bottom)])
    layers = []
    for box in sorted(boxes, key=lambda b: (b[1], b[0])):
        crop = foreground.crop(box)
        inner = crop.getbbox()
        if inner:
            layers.append((crop.crop(inner), box[0] + inner[0], box[1] + inner[1]))
    return layers


def layer_role(image, canvas_height):
    """Recognize sparse ornaments without rotating text or dense photos."""
    width, height = image.size
    coverage = float(np.mean(np.asarray(image.getchannel('A')) > 32))
    if height <= 8 and width > height * 10:
        return 'rule'
    if height > canvas_height * .14 and .3 < width / height < 3 and coverage < .16:
        return 'ornament'
    if coverage > .65 and height > canvas_height * .20:
        return 'image'
    if height >= 36:
        return 'title'
    return 'text'


def compose_scene(layers, size, t, duration, index, motion, phase=0):
    width, height = size
    result = Image.new('RGBA', size)
    flow = motion == 'flow'
    # Keep movement visible in long decks while retaining a seamless movie loop.
    cycles = max(1, round(duration / 8))
    wave = 2 * math.pi * t * cycles / duration
    for number, item in enumerate(layers):
        image, left, top = item[:3]
        role = item[3] if len(item) > 3 else layer_role(image, height)
        offset = number * 1.618 + index * .7
        depth = .65 + .35 * math.sin(offset + 1)
        is_visual = role in ('ornament', 'image', 'page', 'title')
        if role == 'title':
            drift_x = (24 if flow else 9) * depth * math.sin(wave + offset)
            drift_y = (13 if flow else 5) * depth * math.sin(wave + offset + 1)
            scale = 1 + (.018 if flow else .008) * math.sin(wave + offset)
        elif is_visual:
            drift_x = (20 if flow else 7) * depth * math.sin(wave + offset)
            drift_y = (14 if flow else 5) * depth * math.sin(wave + offset + 1)
            scale = 1 + (.035 if flow else .012) * math.sin(wave + offset)
        else:
            drift_x = (10 if flow else 3) * math.sin(wave + offset)
            drift_y = (6 if flow else 2) * math.sin(wave + offset)
            scale = 1
        layer = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))), Image.Resampling.BICUBIC) if scale != 1 else image
        if role == 'ornament':
            angle = (wave * 180 / math.pi) * (1 if number % 2 else -1)
            layer = layer.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)
        alpha = 1.0
        enter = exit = 0.0
        if phase and role in ('title', 'text', 'rule'):
            delay = min(.06, number * .018)
            if phase < 0:
                exit = ease((-phase - delay) / .40)
                alpha = 1 - exit
            else:
                enter = 1 - ease((1 - phase - .56 - delay) / (.44 - delay))
                alpha = 1 - enter
        elif phase and role != 'page':
            alpha = 1 - abs(phase)
        if alpha <= 0:
            continue
        if alpha < 1:
            layer = layer.copy()
            layer.putalpha(layer.getchannel('A').point(lambda value: round(value * alpha)))
        x = left + (image.width - layer.width) / 2 + drift_x
        y = top + (image.height - layer.height) / 2 + drift_y
        # Keep ambient movement on the same constrained path during both holds
        # and transitions. Only the explicit entrance/exit may leave the canvas.
        x = min(max(0, x), max(0, width - layer.width))
        y = min(max(0, y), max(0, height - layer.height))
        if role in ('title', 'text', 'rule'):
            x += 24 * enter - 24 * exit
            y += (48 if flow else 24) * enter - (28 if flow else 14) * exit
        else:
            x += phase * (110 if flow else 45) * (1 + depth * .3)
        result.alpha_composite(layer, (round(x), round(y)))
    return result


def main():
    spec = json.loads(Path(sys.argv[1]).read_text())
    width, height, fps = spec['width'], spec['height'], spec['fps']
    duration = len(spec['pages']) * spec['slideSeconds']
    count = round(duration * fps)
    hints = spec.get('backdropHints', [])
    pages = [prepare(file, hints[index] if index < len(hints) else None) for index, file in enumerate(spec['pages'])]
    palettes = {
        'aurora': [(41, 165, 151), (76, 119, 201), (207, 174, 109)],
        'silk': [(95, 142, 199), (169, 190, 211), (93, 165, 187)],
        'ember': [(203, 138, 86), (187, 115, 135), (198, 170, 119)],
    }
    palette = np.array(palettes[spec['style']], dtype=np.float32)
    cycles = max(1, round(duration / 8))
    grid_w, grid_h = 320, 180
    yy, xx = np.mgrid[0:grid_h, 0:grid_w].astype(np.float32)
    xx /= grid_w
    yy /= grid_h
    fontless = []
    for image, base, separated, alpha_fraction in pages:
        factor = min(width * .94 / image.width, height * .94 / image.height)
        foreground = image.resize((round(image.width * factor), round(image.height * factor)), Image.Resampling.LANCZOS)
        layers = content_layers(foreground, separated)
        inset_x = (width - foreground.width) // 2
        inset_y = (height - foreground.height) // 2
        layers = [(layer, left + inset_x, top + inset_y, layer_role(layer, height) if separated else 'page') for layer, left, top in layers]
        fontless.append((layers, base, separated, alpha_fraction))
    ffmpeg_log = open(Path(spec['video']).with_suffix('.ffmpeg.log'), 'wb')
    encoder = subprocess.Popen([spec['ffmpeg'], '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{width}x{height}', '-r', str(fps), '-i', 'pipe:0',
        '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', spec['video']],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=ffmpeg_log)

    def stop(signum, frame):
        encoder.terminate()
        raise SystemExit(130)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    def scene(index, t, phase):
        return compose_scene(fontless[index][0], (width, height), t, duration, index, spec['motion'], phase)

    def moving_sheen(t, index, base):
        # A very soft light wash sits above the rendered page, giving a wall-paper
        # feel even when the uploaded slide has a fully opaque background.
        wave = 2 * math.pi * t * cycles / duration
        dark = float(np.mean(base)) < 125
        overlay = Image.new('RGBA', (width, height), (0, 0, 0, 0))
        glow = Image.new('RGBA', (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(glow)
        colors = palette.astype(np.uint8).tolist()
        for k, color in enumerate(colors):
            cx = int(width * (.08 + .84 * ((math.sin(wave + k) + 1) / 2)))
            cy = int(height * (.15 + .7 * ((math.cos(wave * 2 + k * 2) + 1) / 2)))
            radius = int(min(width, height) * (.12 if dark else .09))
            draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=(*color, 18 if dark else 11))
        glow = glow.filter(ImageFilter.GaussianBlur(48 if dark else 64))
        overlay.alpha_composite(glow)
        band_x = int(width * (.5 + .7 * math.sin(wave)))
        band = Image.new('RGBA', (width, height), (0, 0, 0, 0))
        band_draw = ImageDraw.Draw(band)
        band_draw.polygon([(band_x - 90, 0), (band_x + 20, 0), (band_x + 170, height), (band_x + 60, height)], fill=(*colors[0], 9 if dark else 6))
        overlay.alpha_composite(band.filter(ImageFilter.GaussianBlur(30)))
        return overlay

    def wallpaper(t, base):
        wave = 2 * math.pi * t * cycles / duration
        dark = float(np.mean(base)) < 125
        canvas = np.full((grid_h, grid_w, 3), base, dtype=np.float32)
        for k, color in enumerate(palette):
            cx = .5 + .38 * math.sin(wave + k * 2.1)
            cy = .5 + .34 * math.cos(wave + k * 2.3)
            radius = .22 + .045 * math.sin(wave + k)
            field = np.exp(-((xx - cx)**2 + (yy - cy)**2) / radius)
            # Light slides keep dark text readable; dark slides keep white text readable.
            target = color * .30 + base * .70 if dark else color * .22 + base * .78
            alpha = field[:, :, None] * (.78 if dark else .68)
            canvas = canvas * (1 - alpha) + target * alpha
        # Slow silk-like bands; no independent random flashes or particle flicker.
        ridge = np.sin(xx * 5 + yy * 4 + .6 * np.sin(wave) + .22 * np.sin(yy * 8 - wave))
        canvas += ridge[:, :, None] * (3.2 if dark else 1.8)
        for k, color in enumerate(palette):
            center = .24 + k * .25 + .13 * np.sin(xx * 4 + wave + k * 1.7) + .06 * np.sin(xx * 8 - wave * 2)
            ribbon = np.exp(-((yy - center) / (.018 + .005 * k)) ** 2)
            glow = np.exp(-((yy - center) / .10) ** 2)
            target = color * .55 + base * .45 if dark else color * .18 + base * .82
            alpha = (ribbon * .24 + glow * .22)[:, :, None]
            canvas = canvas * (1 - alpha) + target * alpha
        return Image.fromarray(np.uint8(np.clip(canvas, 0, 255))).resize((width, height), Image.Resampling.BILINEAR).convert('RGBA')

    try:
        for frame in range(count):
            t = frame / fps
            index = min(len(pages) - 1, int(t / spec['slideSeconds']))
            local = t - index * spec['slideSeconds']
            next_index = (index + 1) % len(pages)
            transition = spec['transitionSeconds']
            moving = local >= spec['slideSeconds'] - transition and (index < len(pages)-1 or spec['loop']) and len(pages) > 1
            blend = ease((local - spec['slideSeconds'] + transition) / transition) if moving else 0
            base = fontless[index][1] * (1 - blend) + fontless[next_index][1] * blend
            background = wallpaper(t, base)
            old = scene(index, t, -blend)
            if moving:
                new = scene(next_index, t, 1 - blend)
                # Raster pages with opaque backgrounds still need a true
                # crossfade. Separated pages use object choreography instead,
                # so text clears before the next page enters.
                if not fontless[index][2] or not fontless[next_index][2]:
                    old_frame = background.copy(); old_frame.alpha_composite(old)
                    new_frame = background.copy(); new_frame.alpha_composite(new)
                    result = Image.blend(old_frame, new_frame, blend).convert('RGB')
                else:
                    background.alpha_composite(old)
                    background.alpha_composite(new)
                    result = background.convert('RGB')
            else:
                background.alpha_composite(old)
                result = background.convert('RGB')
            result = Image.alpha_composite(result.convert('RGBA'), moving_sheen(t, index, base)).convert('RGB')
            if frame == 0:
                result.save(spec['poster'])
            encoder.stdin.write(result.tobytes())
            if frame % fps == 0:
                print(json.dumps({'progress': round(15 + frame/count * 78), 'message': f'正在合成 {t:.0f} / {duration:.0f} 秒，30 帧/秒'}), flush=True)
        encoder.stdin.close()
        if encoder.wait() != 0:
            raise RuntimeError('FFmpeg 编码失败')
    finally:
        if encoder.poll() is None:
            encoder.terminate()
            encoder.wait()
        ffmpeg_log.close()
    Path(spec['video']).with_suffix('.layers.json').write_text(json.dumps({'pages': [{'backgroundSeparated': bool(p[2]), 'foregroundAlphaFraction': round(float(p[3]), 6), 'layerCount': len(fontless[i][0]), 'roles': [layer[3] for layer in fontless[i][0]], 'baseColor': p[1].tolist()} for i, p in enumerate(pages)]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
