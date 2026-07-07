"""Generate the two placeholder icons Teams requires (no external deps)."""
import struct, zlib, os

def png(path, size, pixel_fn):
    rows = b''
    for y in range(size):
        rows += b'\x00' + b''.join(pixel_fn(x, y) for x in range(size))
    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xFFFFFFFF)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)  # RGBA
    body = chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + body)

BLUE = (0x2F, 0x6B, 0xD8, 255)
WHITE = (255, 255, 255, 255)
CLEAR = (0, 0, 0, 0)

def color_pixel(x, y):
    # brand-blue square with a white ring motif (the Space365 plaza)
    s = 192
    cx, cy = s / 2, s / 2
    r = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
    if 58 <= r <= 72:
        return bytes(WHITE)
    return bytes(BLUE)

def outline_pixel(x, y):
    # transparent background, white ring
    s = 32
    cx, cy = s / 2, s / 2
    r = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
    if 9 <= r <= 13:
        return bytes(WHITE)
    return bytes(CLEAR)

here = os.path.dirname(os.path.abspath(__file__))
png(os.path.join(here, 'color.png'), 192, color_pixel)
png(os.path.join(here, 'outline.png'), 32, outline_pixel)
print('wrote color.png (192x192) and outline.png (32x32)')
