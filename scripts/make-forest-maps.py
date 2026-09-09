"""Derive tiling PBR maps for the forest scene from the codex-drawn albedo tiles.

Input:  art/forest/<name>_color.png          (1024, flat-lit albedo, drawn by codex)
Output: public/textures/forest/<name>_color.jpg
        public/textures/forest/<name>_normal.jpg
        public/textures/forest/<name>_roughness.jpg
        shots/forest/tiling-<name>.png       (rolled half a tile, for looking at the seam)

Roughness ranges and normal strengths are per material; normals are taken with
wrapped differences so they tile exactly like the colour.
"""
import os
import numpy as np
from PIL import Image

SOURCE = "art/forest"
TARGET = "public/textures/forest"
PROOF = "shots/forest"

MATERIALS = {
    "moss": {"source": "moss_color", "roughness": (0.88, 1.0), "normal": 2.4},
    "floor": {"source": "forest_floor_color", "roughness": (0.72, 0.98), "normal": 2.8},
    "bark": {"source": "bark_conifer_color", "roughness": (0.70, 0.96), "normal": 3.2},
    "granite": {"source": "granite_color", "roughness": (0.45, 0.82), "normal": 2.0},
}


def luminance(rgb):
    return 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]


def periodic_component(u):
    h, w = u.shape
    v = np.zeros_like(u)
    v[0, :] = u[-1, :] - u[0, :]
    v[-1, :] = -v[0, :]
    v[:, 0] += u[:, -1] - u[:, 0]
    v[:, -1] -= u[:, -1] - u[:, 0]
    fx = 2 * np.pi * np.fft.fftfreq(w)
    fy = 2 * np.pi * np.fft.fftfreq(h)
    d = 2 * (np.cos(fy)[:, None] + np.cos(fx)[None, :] - 2)
    d[0, 0] = 1
    s = np.real(np.fft.ifft2(np.fft.fft2(v) / d))
    return u - (s - s.mean())


def seam_error(a):
    return float(np.abs(a[:, 0] - a[:, -1]).mean() + np.abs(a[0, :] - a[-1, :]).mean()) * 0.5


def make_seamless(rgb):
    before = seam_error(luminance(rgb))
    out = np.stack([periodic_component(rgb[..., c]) for c in range(3)], axis=-1)
    out = np.clip(out, 0, 255)
    return out, before, seam_error(luminance(out))


def normal_map(height, strength):
    gx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * 0.5
    gy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * 0.5
    nx = -gx * strength
    ny = -gy * strength
    nz = np.ones_like(height)
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    packed = np.stack([nx / length, ny / length, nz / length], axis=-1) * 0.5 + 0.5
    return (packed * 255).astype(np.uint8)


def roughness_map(height, low, high):
    normalised = (height - height.min()) / max(1e-6, height.max() - height.min())
    return ((high - (high - low) * normalised) * 255).astype(np.uint8)


def tiling_proof(rgb, path):
    a = np.roll(np.roll(rgb.astype(np.uint8), rgb.shape[0] // 2, axis=0), rgb.shape[1] // 2, axis=1)
    Image.fromarray(a).resize((512, 512)).save(path)


def main():
    os.makedirs(TARGET, exist_ok=True)
    os.makedirs(PROOF, exist_ok=True)
    for name, spec in MATERIALS.items():
        rgb = np.asarray(Image.open(f"{SOURCE}/{spec['source']}.png").convert("RGB")).astype(float)
        tiled, before, after = make_seamless(rgb)
        height = luminance(tiled) / 255.0
        smoothed = height - height.mean()
        Image.fromarray(tiled.astype(np.uint8)).save(f"{TARGET}/{name}_color.jpg", quality=92)
        Image.fromarray(normal_map(smoothed, spec["normal"])).save(f"{TARGET}/{name}_normal.jpg", quality=92)
        Image.fromarray(roughness_map(height, *spec["roughness"])).save(f"{TARGET}/{name}_roughness.jpg", quality=92)
        tiling_proof(tiled, f"{PROOF}/tiling-{name}.png")
        print(f"{name}: seam {before:.2f} -> {after:.2f}, mean {tiled.reshape(-1, 3).mean(0).round(1)}")


if __name__ == "__main__":
    main()
