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
  const CUBE_H = 14;        // vertical pixels per elevation level (cliff height)

  // ---- World dimensions ----
  // Grid is deliberately larger than the screen can show, so terrain runs off
  // every edge and there is never a visible boundary / floating-island edge.
  const SIZE = 64;          // 64 x 64 tiles — overspills the 320x180 frame on all sides
  const MAXH = 3;           // elevation levels: 0,1,2 (mostly 0/1, rare 2)

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
  // Grass cliff (dirt-under-grass) masonry palette: clod fill, darker mortar
  // outline between clods, and a green crown line at the very top of the cliff.
  const GRASS_CLIFF_FILL = ["#9c7b45", "#8a6c3b", "#ac8a52"]; // earthy clod tones
  const GRASS_CLIFF_MORTAR = "#6d5329"; // darker outline between clods
  const GRASS_CLIFF_CROWN = "#5f9e39";  // grassy lip along the cliff top edge

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

  // ---- Build the world: a flat-ish heightmap + per-tile material/shade. ----
  // Each tile: { h: elevation 0..MAXH-1, mat: key, shade: hex, energy: null|key }
  const tiles = [];

  function terrainHeight(x, y) {
    // Broad low-frequency undulation → mostly level, occasional gentle rise.
    const n = valueNoise(x * 0.08, y * 0.08);
    // Bias hard toward the low end so most of the map is walking-height.
    if (n > 0.82) return 2;   // rare high mesa
    if (n > 0.58) return 1;   // occasional gentle rise
    return 0;                 // the common ground level
  }

  function pickMaterial(x, y, h) {
    // High ground tends rocky; a separate low-freq field carves dirt/sand patches
    // and a broad low-lying field pools bright water so the map reads varied.
    if (h >= 2) return "rock";
    const water = valueNoise(x * 0.06 - 80, y * 0.06 - 80);
    if (h === 0 && water > 0.80) return "water";
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
      const h = terrainHeight(x, y);
      const mat = pickMaterial(x, y, h);
      const pool = MATERIALS[mat];
      const shade = pool[Math.floor(hash2(x + 7, y + 13) * pool.length)];
      tiles[x][y] = { h, mat, shade, energy: null };
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
  // inverse — rotated space back to world indices, for neighbour lookups
  function unrotate(rx, ry, r) {
    const n = SIZE - 1;
    r = ((r % 4) + 4) % 4;
    switch (r) {
      case 0: return [rx, ry];
      case 1: return [n - ry, rx];
      case 2: return [n - rx, n - ry];
      case 3: return [ry, n - rx];
    }
  }

  // Center the grid so its middle sits mid-screen and it overspills all edges.
  // In rotated space the grid center is (n/2, n/2); we offset the origin so that
  // projects to the middle of the frame.
  function project(rx, ry, h) {
    const n = SIZE - 1;
    const cx = (n / 2 - n / 2) * (TW / 2); // 0, kept for clarity
    void cx;
    const originX = RW / 2 + panX;
    const originY = RH / 2 + panY;
    const sx = originX + ((rx - n / 2) - (ry - n / 2)) * (TW / 2);
    const sy = originY + ((rx - n / 2) + (ry - n / 2)) * (TH / 2) - h * CUBE_H;
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

  // Fill one small cell of a cliff SIDE face. The face is a parallelogram: outer
  // top corner (ox,oy), inner top corner (ix,iy), dropping straight down by `drop`.
  // (a,b) index the cell across the top edge (a) and down the drop (b).
  function fillSideSub(ox, oy, ix, iy, drop, rows, a, b, col) {
    const sa = 1 / SUB, sb = 1 / rows;
    const ex = ix - ox, ey = iy - oy;         // along the top edge
    const a0 = a * sa, a1 = (a + 1) * sa, b0 = b * sb, b1 = (b + 1) * sb;
    const px = (u, v) => ox + ex * u;
    const py = (u, v) => oy + ey * u + v * drop;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(px(a0, b0), py(a0, b0));
    ctx.lineTo(px(a1, b0), py(a1, b0));
    ctx.lineTo(px(a1, b1), py(a1, b1));
    ctx.lineTo(px(a0, b1), py(a0, b1));
    ctx.closePath();
    ctx.fill();
  }

  // Draw a grass cliff (dirt-under-grass) SIDE face as MASONRY: loose offset
  // rows of outlined dirt-clod shapes, plus a grassy crown along the top edge —
  // like the reference's stonework side faces, not a flat two-tone fill.
  // Geometry matches fillSideSub: outer top corner (ox,oy) → inner top corner
  // (ix,iy) along the top edge, everything dropping straight down by `drop`.
  // `dark` is the SE/SW shading factor so the two faces stay differently lit.
  function fillGrassCliff(ox, oy, ix, iy, drop, levels, dark, seedx, seedy) {
    const ex = ix - ox, ey = iy - oy;         // vector along the top edge
    const px = (u, v) => ox + ex * u;
    const py = (u, v) => oy + ey * u + v * drop;
    const cols = SUB;                           // clods across the face
    const rowsPerLevel = 3;                     // courses of clods per elevation
    const rows = rowsPerLevel * levels;
    const du = 1 / cols, dv = 1 / rows;
    // grassy crown band: a thin lip of grass green at the very top of the cliff
    const crownV = Math.min(0.16, 4 / drop);
    for (let a = 0; a < cols; a++) {
      ctx.fillStyle = shadeBy(GRASS_CLIFF_CROWN, dark);
      ctx.beginPath();
      ctx.moveTo(px(a * du, 0), py(a * du, 0));
      ctx.lineTo(px((a + 1) * du, 0), py((a + 1) * du, 0));
      ctx.lineTo(px((a + 1) * du, crownV), py((a + 1) * du, crownV));
      ctx.lineTo(px(a * du, crownV), py(a * du, crownV));
      ctx.closePath();
      ctx.fill();
    }
    // clod courses below the crown, each row offset by half a clod
    for (let r = 0; r < rows; r++) {
      const v0 = crownV + (1 - crownV) * (r / rows);
      const v1 = crownV + (1 - crownV) * ((r + 1) / rows);
      const off = (r % 2) * 0.5 * du;           // brick-style offset rows
      for (let a = -1; a < cols; a++) {
        const u0 = a * du + off, u1 = (a + 1) * du + off;
        const cu0 = Math.max(0, u0), cu1 = Math.min(1, u1);
        if (cu1 <= cu0) continue;
        const idx = Math.floor(hash2(seedx + a * 3 + r, seedy + r * 5 - a) * GRASS_CLIFF_FILL.length);
        const fill = shadeBy(GRASS_CLIFF_FILL[idx], dark);
        // inset the clod a hair inside its cell so the mortar shows as an outline
        const inU = (cu1 - cu0) * 0.14, inV = (v1 - v0) * 0.16;
        const cx0 = cu0 + inU, cx1 = cu1 - inU, cy0 = v0 + inV, cy1 = v1 - inV;
        // mortar background block (darker) then the clod on top
        ctx.fillStyle = shadeBy(GRASS_CLIFF_MORTAR, dark);
        ctx.beginPath();
        ctx.moveTo(px(cu0, v0), py(cu0, v0));
        ctx.lineTo(px(cu1, v0), py(cu1, v0));
        ctx.lineTo(px(cu1, v1), py(cu1, v1));
        ctx.lineTo(px(cu0, v1), py(cu0, v1));
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.moveTo(px(cx0, cy0), py(cx0, cy0));
        ctx.lineTo(px(cx1, cy0), py(cx1, cy0));
        ctx.lineTo(px(cx1, cy1), py(cx1, cy1));
        ctx.lineTo(px(cx0, cy1), py(cx0, cy1));
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  // Draw one terrain tile: its top diamond, plus SW/SE cliff faces only where the
  // downhill neighbour (in screen terms) is lower — real local cliffs, no walls.
  function drawTile(cell) {
    const t = tiles[cell.x][cell.y];
    const [cx, cy] = project(cell.rx, cell.ry, t.h);
    if (cx < -TW || cx > RW + TW || cy < -TH || cy > RH + CUBE_H * MAXH + TH) return;

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

    // ---- Cliff side faces (only toward lower neighbours) ----
    // Screen-down-left neighbour is rotated (rx, ry+1); down-right is (rx+1, ry).
    // Draw a face when THIS tile is higher than that neighbour (or the neighbour
    // is off-grid AND this tile sits above base — but base tiles show nothing, so
    // off-grid neighbours never make a wall).
    function neighbourH(nrx, nry) {
      const [wx, wy] = unrotate(nrx, nry, rot);
      if (wx < 0 || wy < 0 || wx >= SIZE || wy >= SIZE) return t.h; // treat as equal → no wall
      return tiles[wx][wy].h;
    }
    const hLeft = neighbourH(cell.rx, cell.ry + 1);
    const hRight = neighbourH(cell.rx + 1, cell.ry);

    const baseTop = emissive ? t.shade : top; // cliffs use the ground material, not glow
    // FLAT cliff shading: each face is one solid fill (side faces read darker than
    // the top face for basic fake-lighting — that's two flat tones, not a gradient).
    const leftFlat = shadeBy(baseTop, 0.72);
    const rightFlat = shadeBy(baseTop, 0.56);

    const isGrass = t.mat === "grass" && !emissive;
    // Left (SW-facing) face. Grass gets masonry/clod stonework; other materials
    // keep the flat voxel-cell subdivision (untouched this pass).
    if (t.h > hLeft) {
      const levels = t.h - hLeft;
      const drop = levels * CUBE_H;
      if (isGrass) {
        fillGrassCliff(cx - hw, cy, cx, cy + hh, drop, levels, 0.78, cell.x * 2, cell.y * 2 + 7);
      } else {
        const rows = SUB * levels;
        for (let a = 0; a < SUB; a++)
          for (let b = 0; b < rows; b++) {
            const col = subShade(leftFlat, cell.x * 2, cell.y * 2 + 7, a, b);
            fillSideSub(cx - hw, cy, cx, cy + hh, drop, rows, a, b, col);
          }
      }
    }
    // Right (SE-facing) face — darker lit than the left.
    if (t.h > hRight) {
      const levels = t.h - hRight;
      const drop = levels * CUBE_H;
      if (isGrass) {
        fillGrassCliff(cx + hw, cy, cx, cy + hh, drop, levels, 0.6, cell.x * 2 + 5, cell.y * 2);
      } else {
        const rows = SUB * levels;
        for (let a = 0; a < SUB; a++)
          for (let b = 0; b < rows; b++) {
            const col = subShade(rightFlat, cell.x * 2 + 5, cell.y * 2, a, b);
            fillSideSub(cx + hw, cy, cx, cy + hh, drop, rows, a, b, col);
          }
      }
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
          fillTopSub(cx, cy, hw, hh, i, j, col);
        }
    } else {
      for (let i = 0; i < SUB; i++)
        for (let j = 0; j < SUB; j++)
          fillTopSub(cx, cy, hw, hh, i, j, subShade(top, cell.x, cell.y, i, j));
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
      const t = tiles[hover.gx][hover.gy];
      const [rx, ry] = rotateCoord(hover.gx, hover.gy, rot);
      const [px, py] = project(rx, ry, t.h);
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
