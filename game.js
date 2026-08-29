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
 *   - Ground colour varies per tile (several grass shades + dirt/sand + rock),
 *     with a light ordered-dither so it doesn't read as one flat slab.
 */

(() => {
  "use strict";

  // ---- Internal (low) resolution. Everything is drawn here, then upscaled. ----
  // ~4x the pixel count of the old 320x180 frame: crisper upscaling AND room for
  // much finer per-tile texture — dense flat-coloured flecks/dither, no gradients.
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

  // Per-material fleck colours: the tiny scattered detail dots (blades, pebbles,
  // ripples) drawn on top of each tile face, matching the reference's speckle.
  const FLECKS = {
    grass: ["#9fe06a", "#63a43a", "#b6ee80"],
    dirt:  ["#e0bd85", "#a97f4f"],
    sand:  ["#f4e6b4", "#c9b070"],
    rock:  ["#d3dae2", "#8f98a4"],
    water: ["#8ee0f7", "#2f9fc9"],
  };

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

  // Scatter flat-coloured flecks across a cliff side face (a parallelogram spanning
  // from the outer top corner (ox,oy) down the drop). Adds detail density without
  // any gradient — the dots are two flat shades of the face's own flat colour.
  function cliffFlecks(ox, oy, ix, iy, drop, faceCol, cell, seed) {
    const n = 7;
    const dark = shadeBy(faceCol, 0.82);
    const light = shadeBy(faceCol, 1.14);
    for (let i = 0; i < n; i++) {
      const r1 = hash2(cell.x * 19 + i * 37 + seed + 1, cell.y * 31 + i * 53 + seed + 2);
      const r2 = hash2(cell.x * 43 + i * 61 + seed + 3, cell.y * 11 + i * 29 + seed + 4);
      // s: horizontal position along top edge (outer->inner), d: down the drop
      const s = r1, d = r2;
      const tx = ox + (ix - ox) * s;
      const ty = oy + (iy - oy) * s + d * drop;
      ctx.fillStyle = (i + cell.x + cell.y) % 2 === 0 ? dark : light;
      ctx.fillRect(Math.round(tx), Math.round(ty), 1, 1);
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

    // Ordered-dither: nudge brightness per-pixel-tile so flat ground shimmers a
    // little with texture instead of reading as a solid slab.
    if (!emissive) {
      const d = ((cell.x * 7 + cell.y * 13) % 5) - 2; // -2..2
      top = shadeBy(top, 1 + d * 0.024);
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

    // Left (SW-facing) face — single flat fill
    if (t.h > hLeft) {
      const drop = (t.h - hLeft) * CUBE_H;
      ctx.fillStyle = leftFlat;
      ctx.beginPath();
      ctx.moveTo(cx - hw, cy);
      ctx.lineTo(cx, cy + hh);
      ctx.lineTo(cx, cy + hh + drop);
      ctx.lineTo(cx - hw, cy + drop);
      ctx.closePath();
      ctx.fill();
      // Flat texture flecks scattered on the cliff face for detail density.
      cliffFlecks(cx - hw, cy, cx, cy + hh, drop, leftFlat, cell, 0);
    }
    // Right (SE-facing) face — single flat fill
    if (t.h > hRight) {
      const drop = (t.h - hRight) * CUBE_H;
      ctx.fillStyle = rightFlat;
      ctx.beginPath();
      ctx.moveTo(cx + hw, cy);
      ctx.lineTo(cx, cy + hh);
      ctx.lineTo(cx, cy + hh + drop);
      ctx.lineTo(cx + hw, cy + drop);
      ctx.closePath();
      ctx.fill();
      // Flat texture flecks scattered on the cliff face for detail density.
      cliffFlecks(cx + hw, cy, cx, cy + hh, drop, rightFlat, cell, 100);
    }

    // ---- Top face (diamond) ----
    // FLAT: one solid fill for the whole diamond top — no gradient, no banding.
    ctx.fillStyle = top;
    ctx.beginPath();
    ctx.moveTo(cx, cy - hh);
    ctx.lineTo(cx + hw, cy);
    ctx.lineTo(cx, cy + hh);
    ctx.lineTo(cx - hw, cy);
    ctx.closePath();
    ctx.fill();

    // ---- Per-tile fleck texture + decorative details ----
    // Dense procedural speckle: many deterministic 1px dots scattered inside the
    // diamond, in the material's flat fleck colours — grass blades, pebbles,
    // ripples. All flat-coloured dots (no gradients); density carries the detail.
    if (!emissive) {
      const flecks = FLECKS[t.mat] || FLECKS.grass;
      const n = t.mat === "water" ? 12 : 16;   // much denser than before
      for (let i = 0; i < n; i++) {
        const r1 = hash2(cell.x * 13 + i * 91 + 3, cell.y * 17 + i * 57 + 5);
        const r2 = hash2(cell.x * 29 + i * 41 + 7, cell.y * 23 + i * 71 + 9);
        // uniform point inside the diamond: |u|+|v| <= 1
        let u = r1 * 2 - 1, v = r2 * 2 - 1;
        if (Math.abs(u) + Math.abs(v) > 1) { u = Math.sign(u) - u; v = Math.sign(v) - v; }
        const fx = Math.round(cx + u * hw);
        const fy = Math.round(cy + v * hh);
        const col = flecks[Math.floor(hash2(cell.x + i * 3, cell.y + i * 5) * flecks.length)];
        ctx.fillStyle = col;
        // slightly larger tufts occasionally for grass — still flat colour
        const big = t.mat === "grass" && r1 > 0.88;
        ctx.fillRect(fx, fy, big ? 2 : 1, 1);
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
