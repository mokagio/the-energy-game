# The Energy Game

A retro, pixelated **isometric voxel** canvas prototype for "the energy game". It keeps a real 3D grid of cubes (a 12×12 heightmap, a few layers tall) and renders each voxel as an isometric diamond cube (top + two shaded side faces) onto a tiny 320×180 offscreen canvas that's upscaled with `image-rendering: pixelated` — so it reads as crisp, blocky SNES-era pixel art rather than smooth 3D. Scattered "energy" tiles (yellow cores and cyan accents) pulse against a slow day-length sky-color cycle for the energy theme. Pure HTML/CSS/vanilla JS — no WebGL, no libraries, no build step, no assets.

## Run it

Just open `index.html` in a browser. Or serve it statically:

```
python3 -m http.server    # then visit http://localhost:8000
# or
npx serve
```

Deployed as-is via GitHub Pages from the repo root on `main`.

## Controls

- **Drag** left/right, or **←/→**: rotate the isometric view.
- **↑/↓**: pan up/down.
- **Click a tile**: toggle it as an "energized" (pulsing) tile.

## Status

This is an early **visual / tech prototype** — an isometric voxel renderer with a light energy theme — not the full game design. No scoring, objectives, or real mechanics yet.
