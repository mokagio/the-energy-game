/* The Energy Game — retro pixelated isometric RTS-style terrain.
 *
 * Renders a large ground plane in isometric ("dimetric" 2:1) projection onto a
 * TINY offscreen canvas, then upscales it with CSS image-rendering: pixelated so
 * everything reads as crisp blocky pixel art (SNES / StarCraft / Age of Empires
 * feel) rather than smooth modern 3D. No WebGL, no libraries, no assets.
 *
 * Key ideas that make it read as an "infinite" RTS map rather than a floating
 * Minecraft chunk:
 *   - The tile grid is much larger than the visible frame and is anchored so the
 *     diamond overspills all four screen edges — no void border, no island.
 *   - Terrain is nearly flat (mostly one walking level, occasional +1, rare +2).
 *   - Side (cliff) faces are drawn ONLY where a tile is taller than its downhill
 *     neighbour — i.e. real local cliffs/ramps — never as a wall around the map
 *     boundary (there is no visible boundary).
 *   - Every unit tile is itself a 4x4 grid of tiny voxel cells (mini-cubes), so a
 *     single map square reads as a dense little voxel cluster, not one large flat
 *     block face — the opposite of Minecraft's one-big-textured-square-per-face.
 *   - Each sub-cell picks from a couple of close shades of the tile's base colour
 *     (deterministic, quiet) for subtle texture — no loud scattered colour noise.
 */

(() => {
  "use strict";

  // ---- Internal (low) resolution. Everything is drawn here, then upscaled. ----
  // ~4x the pixel count of the old 320x180 frame: crisper upscaling AND room for
  // the fine 4x4 voxel sub-grid rendered inside every unit tile, no gradients.
  const RW = 640;
  const RH = 360;

  const display = document.getElementById("game");
  display.width = RW;
  display.height = RH;
  const ctx = display.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  // ---- Isometric projection constants ----
  const TW = 32;            // tile width  (full diamond width)
  const TH = 16;            // tile height (full diamond height) -> 2:1 dimetric

  // ---- World dimensions ----
  // Grid is deliberately larger than the screen can show, so terrain runs off
  // every edge and there is never a visible boundary / floating-island edge.
  // The map is a single FLAT plane — no elevation, no cliffs (removed).
  const SIZE = 64;          // 64 x 64 tiles — overspills the 320x180 frame on all sides

  // Ground palette. A tile picks a base "material" then a shade of it. Every
  // face colour derives from the top colour so cliffs read as the same material.
  // materials: pools of top-face colours. Bright, saturated, warm and cheerful —
  // matching the "Peaceful Plains / Whispering Woods" reference feel: light
  // saturated grass greens, warm tan dirt/sand paths, cool light stone, and
  // clean bright water. Nothing dark, muddy, or desaturated.
  const MATERIALS = {
    grass: ["#7dc24b", "#8ace55", "#74b845", "#93d55f", "#6aad3f"],
    dirt:  ["#c9a06a", "#d3ac76", "#bd9560"],   // warm light tan path
    sand:  ["#e2cf92", "#ecd99f", "#d8c384"],   // pale warm sand
    rock:  ["#b3bcc6", "#a5aeb9", "#c2cad3"],   // cool light blue-grey stone
    water: ["#4ec3e8", "#3fb6df", "#5fcef0"],   // clean bright blue
  };

  // Grass reads as clustered organic patches of a few close greens (like the
  // reference tileset), NOT a flat fill or scattered speckle. These are the
  // 4 tones a grass top-face is quantised into — from a darker shadow green up
  // to a bright highlight green. Structured value-noise (below) picks which tone
  // each sub-cell lands on, so the clumps are deterministic and repeatable.
  const GRASS_TONES = ["#5f9e39", "#74b845", "#8ace55", "#a6e070"];
  // Slightly darker green used to outline the diamond border for a "cut" look.
  const GRASS_EDGE = "#4e8a2e";

  // ---- Per-material clustered tone palettes (dirt/sand/rock/water) ----------
  // Same spirit as GRASS_TONES: each material top-face is quantised into 3-4
  // close tones of its own palette; deterministic value-noise (or a material-
  // specific structured pattern) decides which tone each sub-cell lands on, so
  // the result reads as organic clumps / seams / grain — never flat, speckle,
  // or a gradient. Ordered darkest → lightest.
  const DIRT_TONES  = ["#a5814f", "#bd9560", "#c9a06a", "#d8b47f"]; // patchy clods
  const DIRT_FLECK  = "#6f5330"; // occasional dark pebble / root fleck
  const SAND_TONES  = ["#d8c384", "#e2cf92", "#ecd99f", "#f4e4ad"]; // fine grain
  const ROCK_TONES  = ["#9aa4b0", "#a5aeb9", "#b3bcc6", "#c2cad3"]; // flagstone
  const ROCK_SEAM   = "#7c8794"; // dark seam/crack between flagstones
  const WATER_TONES = ["#3fb6df", "#4ec3e8", "#5fcef0", "#7ddbf5"]; // ripple bands

  // Each unit tile is built out of a SUB x SUB grid of little voxel cells (mini
  // isometric cubes) rather than one big flat diamond. That fine subdivision — not
  // scattered colour flecks — is what carries the detail and reads as dense voxel
  // art instead of one flat Minecraft block face.
  const SUB = 4;            // 4x4 voxel cells per unit tile

  // Energy (emissive) tile top colours — these pulse with the energy theme.
  const ENERGY = {
    ecore: "#ffe14d",   // yellow core
    cyan:  "#4dffe1",   // cyan conduit
  };

  // ---- Deterministic value noise (no deps) for a gentle heightmap + material. ----
  function hash2(x, y) {
    let h = x * 374761393 + y * 668265263;
    h = (h ^ (h >> 13)) * 1274126177;
    h = h ^ (h >> 16);
    return ((h >>> 0) % 100000) / 100000; // 0..1
  }
  function smooth(a, b, t) { const s = t * t * (3 - 2 * t); return a + (b - a) * s; }
  function valueNoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const v00 = hash2(xi, yi), v10 = hash2(xi + 1, yi);
    const v01 = hash2(xi, yi + 1), v11 = hash2(xi + 1, yi + 1);
    return smooth(smooth(v00, v10, xf), smooth(v01, v11, xf), yf);
  }

  // ---- Build the world: a single FLAT plane + per-tile material/shade. ----
  // Elevation was removed — the whole map renders as one flat level. Each tile:
  // { mat: key, shade: hex, energy: null|key }
  const tiles = [];

  function pickMaterial(x, y) {
    // Low-freq fields carve dirt/rock/sand patches and pool bright water so the
    // flat map still reads as varied terrain. (No height dependence any more.)
    const water = valueNoise(x * 0.06 - 80, y * 0.06 - 80);
    if (water > 0.80) return "water";
    const patch = valueNoise(x * 0.13 + 40, y * 0.13 + 40);
    const patch2 = valueNoise(x * 0.21 - 15, y * 0.21 - 15);
    if (patch > 0.82) return "rock";
    if (water > 0.72) return "sand";   // sandy shore ringing the water
    if (patch2 < 0.20) return "dirt";
    return "grass";
  }

  for (let x = 0; x < SIZE; x++) {
    tiles[x] = [];
    for (let y = 0; y < SIZE; y++) {
      const mat = pickMaterial(x, y);
      const pool = MATERIALS[mat];
      const shade = pool[Math.floor(hash2(x + 7, y + 13) * pool.length)];
      tiles[x][y] = { mat, shade, energy: null };
    }
  }

  // Scatter energy "sources" as clusters on the ground, roughly toward the middle
  // of the visible area so they read as part of the playfield.
  const sourceCenters = [
    [30, 28], [36, 34], [26, 38], [40, 26], [32, 41], [38, 38],
  ];
  for (const [sx, sy] of sourceCenters) {
    if (!tiles[sx] || !tiles[sx][sy]) continue;
    tiles[sx][sy].energy = (sx + sy) % 2 === 0 ? "ecore" : "cyan";
    // a couple of cyan conduits trailing off each core
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const t = tiles[sx + dx] && tiles[sx + dx][sy + dy];
      if (t && Math.random() < 0.9) t.energy = "cyan";
    }
  }

  // ---- Colour helpers ----
  function hex(c) {
    if (c[0] === "#") {
      return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
    }
    const m = c.match(/\d+/g);
    return [+m[0], +m[1], +m[2]];
  }
  function rgb(a) { return `rgb(${a[0]},${a[1]},${a[2]})`; }
  function mix(a, b, t) {
    const ca = hex(a), cb = hex(b);
    return rgb([
      Math.round(ca[0] + (cb[0] - ca[0]) * t),
      Math.round(ca[1] + (cb[1] - ca[1]) * t),
      Math.round(ca[2] + (cb[2] - ca[2]) * t),
    ]);
  }
  function shadeBy(color, f) {
    const c = hex(color);
    return rgb([
      Math.max(0, Math.min(255, Math.round(c[0] * f))),
      Math.max(0, Math.min(255, Math.round(c[1] * f))),
      Math.max(0, Math.min(255, Math.round(c[2] * f))),
    ]);
  }

  // ---- View state: rotation (quarter turns) + pan ----
  let rot = 0;
  let targetRot = 0;
  let panX = 0, panY = 0;

  const energized = new Set();
  const key = (x, y) => `${x},${y}`;

  function rotateCoord(x, y, r) {
    const n = SIZE - 1;
    r = ((r % 4) + 4) % 4;
    switch (r) {
      case 0: return [x, y];
      case 1: return [y, n - x];
      case 2: return [n - x, n - y];
      case 3: return [n - y, x];
    }
  }
  // Center the grid so its middle sits mid-screen and it overspills all edges.
  // In rotated space the grid center is (n/2, n/2); we offset the origin so that
  // projects to the middle of the frame. Flat plane — no height term.
  function project(rx, ry) {
    const n = SIZE - 1;
    const originX = RW / 2 + panX;
    const originY = RH / 2 + panY;
    const sx = originX + ((rx - n / 2) - (ry - n / 2)) * (TW / 2);
    const sy = originY + ((rx - n / 2) + (ry - n / 2)) * (TH / 2);
    return [sx, sy];
  }

  // Quiet per-sub-cell shade: pick one of 3 close shades of the face colour,
  // deterministically from the cell's world coords + sub index. This is the ONLY
  // texture now — a small ±brightness step, nowhere near the old fleck-dot noise.
  const SUB_SHADES = [0.94, 1.0, 1.07];
  function subShade(baseCol, gx, gy, i, j) {
    const idx = Math.floor(hash2(gx * 4 + i + 1, gy * 4 + j + 2) * SUB_SHADES.length);
    return shadeBy(baseCol, SUB_SHADES[idx]);
  }

  // ---- Grass: clustered organic patch shading ----------------------------
  // The grass top face is quantised into GRASS_TONES. To get soft ORGANIC
  // clumps (not a per-cell speckle, not a flat fill) we sample a smooth
  // low-frequency value-noise field in continuous tile-local UV space: nearby
  // sub-cells read almost the same noise value, so they fall into the same tone
  // band and merge into a patch a few cells wide — exactly the clumped look of
  // the reference grass. It's fully deterministic (seeded on world tile coords),
  // so a given tile always textures identically frame to frame.
  //
  // gx,gy: world tile coords (the seed/offset into the noise field, so adjacent
  // tiles' patches flow into each other instead of tiling visibly).
  // u,v in [0,1): position of this sub-cell's CENTRE within the tile.
  function grassTone(gx, gy, u, v) {
    // Two octaves of continuous noise → blobby clusters with a little internal
    // variation. Frequency ~2.2 across a tile gives clumps a couple cells wide.
    const fx = gx + u, fy = gy + v;
    let n = valueNoise(fx * 2.2 + 11.3, fy * 2.2 + 4.7) * 0.68
          + valueNoise(fx * 5.1 - 3.1, fy * 5.1 + 9.9) * 0.32;
    // Map noise (roughly 0.2..0.8) across the 4 tones with a light bias toward
    // the mid greens so highlights/shadows read as occasional accents, not half
    // the tile.
    n = (n - 0.2) / 0.6;
    n = Math.max(0, Math.min(0.999, n));
    // bias curve: pull toward centre so extreme tones are rarer
    const biased = n < 0.5
      ? 0.5 * Math.pow(n * 2, 1.4)
      : 1 - 0.5 * Math.pow((1 - n) * 2, 1.4);
    const idx = Math.min(GRASS_TONES.length - 1, Math.floor(biased * GRASS_TONES.length));
    return GRASS_TONES[idx];
  }

  // ---- Per-material top-face texture functions --------------------------------
  // Each mirrors grassTone's spirit: continuous fields (seeded on world tile
  // coords so patterns flow across tile borders, no visible tiling) quantised
  // into a material's close-tone palette. Returned as a hex/rgb string per
  // sub-cell. Distinct STRUCTURE per material — clods, grain, flagstones, ripple
  // bands — so each reads differently from the others. No gradients, no speckle.

  // DIRT: patchy clods — broad blobby clusters (like grass but on tan tones),
  // with the occasional darker pebble/root fleck stamped on isolated cells.
  function dirtTone(gx, gy, u, v) {
    const fx = gx + u, fy = gy + v;
    let n = valueNoise(fx * 2.4 + 5.5, fy * 2.4 + 18.2) * 0.66
          + valueNoise(fx * 6.3 - 7.7, fy * 6.3 + 2.1) * 0.34;
    n = Math.max(0, Math.min(0.999, (n - 0.22) / 0.56));
    // occasional dark fleck: high-frequency field spikes on a few scattered cells
    const fleck = valueNoise(fx * 9.7 + 30.0, fy * 9.7 - 12.0);
    if (fleck > 0.86) return DIRT_FLECK;
    const idx = Math.min(DIRT_TONES.length - 1, Math.floor(n * DIRT_TONES.length));
    return DIRT_TONES[idx];
  }

  // SAND: fine tight grain — a high-frequency ordered dither so it reads as a
  // dense even grain rather than big blobs. A gentle low-freq drift keeps whole
  // dunes very slightly lighter/darker without ever banding.
  function sandTone(gx, gy, u, v) {
    const fx = gx + u, fy = gy + v;
    // per-sub-cell hash gives the tight grain; low-freq noise biases the level.
    const grain = hash2(Math.round(fx * SUB) + 101, Math.round(fy * SUB) + 202);
    const drift = valueNoise(fx * 1.3 + 60.0, fy * 1.3 - 40.0); // 0..1 slow
    let n = grain * 0.7 + drift * 0.3;
    n = Math.max(0, Math.min(0.999, n));
    const idx = Math.min(SAND_TONES.length - 1, Math.floor(n * SAND_TONES.length));
    return SAND_TONES[idx];
  }

  // ROCK: cracked flagstone / tile-seams. A cell field partitions the surface
  // into irregular flagstones (all cells of one stone share a tone); the thin
  // border between neighbouring stones is drawn as a dark seam.
  function rockTone(gx, gy, u, v) {
    const fx = gx + u, fy = gy + v;
    // Which flagstone does this point belong to? Snap to a coarse jittered grid.
    const cellSize = 0.5; // ~2 flagstones across a tile
    // jitter each grid node so seams aren't a perfect lattice
    const gxx = Math.floor(fx / cellSize), gyy = Math.floor(fy / cellSize);
    // distance to nearest seam line, in this jittered grid (Manhattan-ish)
    const jx = hash2(gxx + 3, gyy + 9) * 0.28;   // seam offset within the cell
    const jy = hash2(gxx + 12, gyy + 4) * 0.28;
    const lx = (fx / cellSize) - gxx;            // 0..1 within grid cell
    const ly = (fy / cellSize) - gyy;
    const seam = Math.min(Math.abs(lx - jx), Math.abs(1 - lx - jx),
                          Math.abs(ly - jy), Math.abs(1 - ly - jy));
    if (seam < 0.10) return ROCK_SEAM;           // dark crack between stones
    // each flagstone gets one of the light stone tones, deterministically
    const idx = Math.floor(hash2(gxx * 2 + 1, gyy * 2 + 7) * ROCK_TONES.length);
    return ROCK_TONES[Math.min(ROCK_TONES.length - 1, idx)];
  }

  // WATER: horizontal flowing ripple bands. Tone is driven mostly by SCREEN-ish
  // horizontal position (v across the tile) warped by a slow noise so the bands
  // undulate like moving water, plus a subtle animated drift over time.
  function waterTone(gx, gy, u, v) {
    const fx = gx + u, fy = gy + v;
    // horizontal bands: use (u+v) which runs along the flat "waterline" axis,
    // warped by low-freq noise so the bands wave rather than stripe perfectly.
    const warp = valueNoise(fx * 1.7 + 50.0, fy * 1.7 + 15.0) - 0.5;
    const band = Math.sin((fx + fy) * 3.4 + warp * 4.0 + now * 0.0016);
    let n = 0.5 + 0.5 * band;                    // 0..1 across the band cycle
    n = Math.max(0, Math.min(0.999, n));
    const idx = Math.min(WATER_TONES.length - 1, Math.floor(n * WATER_TONES.length));
    return WATER_TONES[idx];
  }

  // Fill one small isometric sub-diamond of a tile's TOP face. The top face is a
  // diamond centred at (cx,cy) with half-width hw / half-height hh. In its (u,v)
  // unit-square space a point maps to
  //   px = cx + (u - v) * hw ,  py = cy + (u + v - 1) * hh .
  // (i,j) is the sub-cell; each spans 1/SUB in u and v.
  function fillTopSub(cx, cy, hw, hh, i, j, col) {
    const s = 1 / SUB;
    const u0 = i * s, u1 = (i + 1) * s, v0 = j * s, v1 = (j + 1) * s;
    const px = (u, v) => cx + (u - v) * hw;
    const py = (u, v) => cy + (u + v - 1) * hh;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(px(u0, v0), py(u0, v0));
    ctx.lineTo(px(u1, v0), py(u1, v0));
    ctx.lineTo(px(u1, v1), py(u1, v1));
    ctx.lineTo(px(u0, v1), py(u0, v1));
    ctx.closePath();
    ctx.fill();
  }

  // Draw one terrain tile: a single flat top diamond, subdivided into a 4x4 grid
  // of tiny voxel sub-diamonds. Elevation/cliffs were removed — the whole map is
  // one flat plane, so there are no side faces.
  function drawTile(cell) {
    const t = tiles[cell.x][cell.y];
    const [cx, cy] = project(cell.rx, cell.ry);
    if (cx < -TW || cx > RW + TW || cy < -TH || cy > RH + TH) return;

    const hw = TW / 2, hh = TH / 2;

    // Base top colour.
    let top;
    let emissive = false;
    if (t.energy) { top = ENERGY[t.energy]; emissive = true; }
    else top = t.shade;

    const hl = energized.has(key(cell.x, cell.y));
    if (emissive || hl) {
      const p = 0.5 + 0.5 * Math.sin(now * 0.004 + cell.x * 0.3 + cell.y * 0.2);
      top = mix(top, "#ffffff", 0.15 + 0.4 * p);
    }

    // ---- Top face: a 4x4 grid of tiny voxel sub-diamonds ----
    // Instead of one big flat diamond, draw SUB x SUB little iso sub-diamonds, each
    // a quiet close shade of the tile's base colour. That fine subdivision is the
    // detail — it reads as a dense voxel cluster, not one flat Minecraft square.
    if (emissive) {
      // Emissive tiles: keep the glow solid but still faceted into sub-cells so the
      // structure matches; the pulse colour is uniform across the cell.
      for (let i = 0; i < SUB; i++)
        for (let j = 0; j < SUB; j++)
          fillTopSub(cx, cy, hw, hh, i, j, top);
    } else if (t.mat === "grass") {
      // Grass: clustered organic patch shading. Each sub-cell takes a green tone
      // from the smooth noise field so adjacent cells merge into clumps, then a
      // darker edge is stamped along the diamond border for a "cut" definition.
      const s = 1 / SUB;
      for (let i = 0; i < SUB; i++)
        for (let j = 0; j < SUB; j++) {
          // centre of this sub-cell in tile-local UV
          const u = (i + 0.5) * s, v = (j + 0.5) * s;
          let col = grassTone(cell.x, cell.y, u, v);
          // Darker edge near the diamond outline: cells on the outer ring get
          // nudged toward the edge green so the tile reads as a cut block.
          // Only the two lower (front-facing) edges get the darker "cut" line —
          // like the reference, where the shaded lip sits on the near borders and
          // the far borders stay bright, so tiles still merge across the field.
          const onLowerEdge = i === SUB - 1 || j === SUB - 1;
          const onUpperEdge = i === 0 || j === 0;
          if (onLowerEdge) col = mix(col, GRASS_EDGE, 0.5);
          else if (onUpperEdge) col = mix(col, GRASS_EDGE, 0.22);
          if (hl) col = mix(col, top, 0.6); // fold in the highlight pulse
          fillTopSub(cx, cy, hw, hh, i, j, col);
        }
    } else {
      // Dirt / sand / rock / water: each material's own clustered/patterned tone
      // function fills the sub-cells (same quality bar as grass, distinct look
      // per material). Highlighted (energized) non-emissive tiles blend their
      // textured colour toward the pulse so the click feedback still reads.
      const s = 1 / SUB;
      const toneFn = t.mat === "dirt" ? dirtTone
                   : t.mat === "sand" ? sandTone
                   : t.mat === "rock" ? rockTone
                   : t.mat === "water" ? waterTone
                   : null;
      for (let i = 0; i < SUB; i++)
        for (let j = 0; j < SUB; j++) {
          const u = (i + 0.5) * s, v = (j + 0.5) * s;
          let col = toneFn ? toneFn(cell.x, cell.y, u, v)
                           : subShade(top, cell.x, cell.y, i, j);
          if (hl) col = mix(col, top, 0.6); // fold in the highlight pulse
          fillTopSub(cx, cy, hw, hh, i, j, col);
        }
    }

    // faint glow ring around emissive tiles
    if (emissive) {
      const p = 0.5 + 0.5 * Math.sin(now * 0.005 + cell.x + cell.y);
      ctx.strokeStyle = mix(ENERGY[t.energy], "#ffffff", 0.3 + 0.3 * p);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy - hh);
      ctx.lineTo(cx + hw, cy);
      ctx.lineTo(cx, cy + hh);
      ctx.lineTo(cx - hw, cy);
      ctx.closePath();
      ctx.stroke();
    }

    pickList.push({ sx: cx, sy: cy, gx: cell.x, gy: cell.y });
  }

  // ---- Picking ----
  let pickList = [];
  function pickAt(mx, my) {
    for (let i = pickList.length - 1; i >= 0; i--) {
      const p = pickList[i];
      const dx = Math.abs(mx - p.sx) / (TW / 2);
      const dy = Math.abs(my - p.sy) / (TH / 2);
      if (dx + dy <= 1) return p;
    }
    return null;
  }

  // ---- Render loop ----
  let now = 0;
  function render(ts) {
    now = ts || 0;
    if (rot !== targetRot) rot = ((targetRot % 4) + 4) % 4;

    // Bright grassy base so the extreme left/right diamond pinch never shows as a
    // void — any gap reads as more of the same cheerful ground, not a dark border.
    ctx.fillStyle = "#6aad3f";
    ctx.fillRect(0, 0, RW, RH);

    pickList = [];

    // Painter's order: build rotated cells, sort back-to-front by (rx+ry).
    const cells = [];
    for (let x = 0; x < SIZE; x++) {
      for (let y = 0; y < SIZE; y++) {
        const [rx, ry] = rotateCoord(x, y, rot);
        cells.push({ x, y, rx, ry });
      }
    }
    cells.sort((a, b) => (a.rx + a.ry) - (b.rx + b.ry));

    for (const cell of cells) drawTile(cell);

    // Hovered-tile outline
    if (hover) {
      const [rx, ry] = rotateCoord(hover.gx, hover.gy, rot);
      const [px, py] = project(rx, ry);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, py - TH / 2);
      ctx.lineTo(px + TW / 2, py);
      ctx.lineTo(px, py + TH / 2);
      ctx.lineTo(px - TW / 2, py);
      ctx.closePath();
      ctx.stroke();
    }

    requestAnimationFrame(render);
  }

  // ---- Input ----
  let dragging = false;
  let dragStartX = 0, dragMoved = false;
  let hover = null;

  function toInternal(ev) {
    const rect = display.getBoundingClientRect();
    const mx = ((ev.clientX - rect.left) / rect.width) * RW;
    const my = ((ev.clientY - rect.top) / rect.height) * RH;
    return [mx, my];
  }

  display.addEventListener("mousedown", (ev) => {
    dragging = true;
    dragMoved = false;
    dragStartX = ev.clientX;
  });

  window.addEventListener("mouseup", (ev) => {
    if (dragging && !dragMoved) {
      const [mx, my] = toInternal(ev);
      const p = pickAt(mx, my);
      if (p) {
        const k = key(p.gx, p.gy);
        if (energized.has(k)) energized.delete(k);
        else energized.add(k);
      }
    }
    dragging = false;
  });

  window.addEventListener("mousemove", (ev) => {
    const [mx, my] = toInternal(ev);
    hover = pickAt(mx, my);
    if (dragging) {
      const dx = ev.clientX - dragStartX;
      if (Math.abs(dx) > 40) {
        targetRot += dx > 0 ? 1 : -1;
        dragStartX = ev.clientX;
        dragMoved = true;
      }
    }
  });

  window.addEventListener("keydown", (ev) => {
    switch (ev.key) {
      case "ArrowLeft":  targetRot -= 1; ev.preventDefault(); break;
      case "ArrowRight": targetRot += 1; ev.preventDefault(); break;
      case "ArrowUp":    panY += 10; ev.preventDefault(); break;
      case "ArrowDown":  panY -= 10; ev.preventDefault(); break;
    }
  });

  requestAnimationFrame(render);
})();
