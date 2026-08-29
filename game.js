/* The Energy Game — retro pixelated isometric voxel prototype.
 *
 * We keep a real 3D grid of voxels (x, y, z each with a type/color), then draw
 * each solid cube as an isometric "diamond" (top face + two side faces) onto a
 * TINY offscreen canvas. That small canvas is upscaled by CSS with
 * image-rendering: pixelated, so everything reads as crisp blocky pixel art
 * instead of smooth modern 3D. No WebGL, no libraries, no assets.
 */

(() => {
  "use strict";

  // ---- Internal (low) resolution. Everything is drawn here, then upscaled. ----
  const RW = 320;
  const RH = 180;

  const display = document.getElementById("game");
  display.width = RW;
  display.height = RH;
  const ctx = display.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  // ---- World dimensions ----
  const SIZE = 12;      // 12 x 12 base footprint
  const MAXH = 6;       // max stack height

  // Voxel types. `emissive` tiles pulse with the energy theme.
  const TYPES = {
    grass:  { top: "#4a7a3a", left: "#345c29", right: "#28471f", emissive: false },
    dirt:   { top: "#7a5a3a", left: "#5c4429", right: "#47341f", emissive: false },
    stone:  { top: "#6d7280", left: "#50545f", right: "#3c3f47", emissive: false },
    water:  { top: "#2f6fb0", left: "#245488", right: "#1b3f66", emissive: false },
    // energy tiles — bright, they pulse:
    ecore:  { top: "#ffe14d", left: "#d4a800", right: "#a37f00", emissive: true },
    cyan:   { top: "#4dffe1", left: "#00c4a8", right: "#009182", emissive: true },
  };

  // ---- Build the world: a heightmap of stacked voxels. ----
  // grid[x][y] = array of type keys from z=0 (bottom) upward.
  const grid = [];

  function pseudoHeight(x, y) {
    // deterministic wavy heightmap, no dependencies
    const a = Math.sin(x * 0.9) + Math.cos(y * 0.7);
    const b = Math.sin((x + y) * 0.5);
    const h = (a + b + 3) / 6; // ~0..1
    return 1 + Math.round(h * (MAXH - 1));
  }

  for (let x = 0; x < SIZE; x++) {
    grid[x] = [];
    for (let y = 0; y < SIZE; y++) {
      let h = pseudoHeight(x, y);
      const stack = [];
      for (let z = 0; z < h; z++) {
        let type;
        if (z === h - 1) {
          type = h <= 2 ? "water" : h >= MAXH - 1 ? "stone" : "grass";
        } else {
          type = "dirt";
        }
        stack.push(type);
      }
      grid[x][y] = stack;
    }
  }

  // Scatter a few energy tiles as decorative "sources" on top of stacks.
  const energyTiles = []; // {x,y,z}
  const sources = [
    [2, 3], [9, 2], [5, 8], [10, 9], [3, 10], [7, 5],
  ];
  for (const [sx, sy] of sources) {
    const stack = grid[sx][sy];
    const z = stack.length - 1;
    stack[z] = (sx + sy) % 2 === 0 ? "ecore" : "cyan";
    energyTiles.push({ x: sx, y: sy, z });
  }

  // ---- Isometric projection ----
  const TW = 16;            // tile width (full diamond width)
  const TH = 8;             // tile height (full diamond height) -> 2:1 dimetric
  const CUBE_H = 8;         // vertical pixels per voxel layer

  // View state: rotation (0..3 quarter turns) + pan.
  let rot = 0;              // integer quarter-turns
  let targetRot = 0;
  let panX = 0, panY = 0;

  // A pulsing "energized" set the player toggles by clicking.
  const energized = new Set();
  const key = (x, y, z) => `${x},${y},${z}`;

  // Rotate world coords by the current quarter-turn so rotation looks 3D-ish.
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

  // Convert grid (rx, ry, z) to screen pixel of the TOP diamond's center.
  function project(rx, ry, z) {
    const originX = RW / 2 + panX;
    const originY = 34 + panY;
    const sx = originX + (rx - ry) * (TW / 2);
    const sy = originY + (rx + ry) * (TH / 2) - z * CUBE_H;
    return [sx, sy];
  }

  function drawCube(cx, cy, type, highlight) {
    const t = TYPES[type];
    const hw = TW / 2;
    const hh = TH / 2;

    let top = t.top, left = t.left, right = t.right;

    if (t.emissive || highlight) {
      // pulse the emissive tiles (and any player-energized tile)
      const p = 0.5 + 0.5 * Math.sin(now * 0.004 + cx * 0.3 + cy * 0.2);
      top = mix(top, "#ffffff", 0.15 + 0.45 * p);
      left = mix(left, "#ffffff", 0.1 + 0.25 * p);
      right = mix(right, "#ffffff", 0.05 + 0.2 * p);
    }

    // Top face (diamond)
    ctx.fillStyle = top;
    ctx.beginPath();
    ctx.moveTo(cx, cy - hh);
    ctx.lineTo(cx + hw, cy);
    ctx.lineTo(cx, cy + hh);
    ctx.lineTo(cx - hw, cy);
    ctx.closePath();
    ctx.fill();

    // Left face
    ctx.fillStyle = left;
    ctx.beginPath();
    ctx.moveTo(cx - hw, cy);
    ctx.lineTo(cx, cy + hh);
    ctx.lineTo(cx, cy + hh + CUBE_H);
    ctx.lineTo(cx - hw, cy + CUBE_H);
    ctx.closePath();
    ctx.fill();

    // Right face
    ctx.fillStyle = right;
    ctx.beginPath();
    ctx.moveTo(cx + hw, cy);
    ctx.lineTo(cx, cy + hh);
    ctx.lineTo(cx, cy + hh + CUBE_H);
    ctx.lineTo(cx + hw, cy + CUBE_H);
    ctx.closePath();
    ctx.fill();
  }

  // Simple hex color mixing helper.
  function mix(a, b, t) {
    const ca = hex(a), cb = hex(b);
    const r = Math.round(ca[0] + (cb[0] - ca[0]) * t);
    const g = Math.round(ca[1] + (cb[1] - ca[1]) * t);
    const bl = Math.round(ca[2] + (cb[2] - ca[2]) * t);
    return `rgb(${r},${g},${bl})`;
  }
  function hex(c) {
    if (c[0] === "#") {
      return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
    }
    const m = c.match(/\d+/g);
    return [ +m[0], +m[1], +m[2] ];
  }

  // ---- Day-length color cycle for the sky background ----
  function skyColor(t) {
    const phase = (Math.sin(t * 0.0002) + 1) / 2; // 0 night .. 1 day
    return mix("#0b0e1a", "#20345a", phase);
  }

  // ---- Picking: figure out which top tile the mouse is over. ----
  // We store the drawn top-diamond centers each frame for hit testing.
  let pickList = []; // {sx, sy, gx, gy, gz}

  function pickAt(mx, my) {
    // iterate front-to-back (reverse of draw order) so topmost wins
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

    // smooth rotation snapping
    if (rot !== targetRot) {
      // we only render at integer rotations to keep pixels crisp; snap instantly
      rot = targetRot;
    }

    ctx.fillStyle = skyColor(now);
    ctx.fillRect(0, 0, RW, RH);

    pickList = [];

    // Draw painter's-algorithm order. After rotation the draw order by
    // (rx + ry) then z keeps back-to-front correct.
    // Build a list of visible voxels in rotated space.
    const cells = [];
    for (let x = 0; x < SIZE; x++) {
      for (let y = 0; y < SIZE; y++) {
        const [rx, ry] = rotateCoord(x, y, rot);
        cells.push({ x, y, rx, ry });
      }
    }
    cells.sort((a, b) => (a.rx + a.ry) - (b.rx + b.ry));

    for (const cell of cells) {
      const stack = grid[cell.x][cell.y];
      for (let z = 0; z < stack.length; z++) {
        const [sx, sy] = project(cell.rx, cell.ry, z);
        if (sx < -TW || sx > RW + TW || sy < -TH || sy > RH + CUBE_H + TH) continue;
        const isTop = z === stack.length - 1;
        const hl = energized.has(key(cell.x, cell.y, z));
        drawCube(sx, sy, stack[z], hl);
        if (isTop) {
          pickList.push({ sx, sy, gx: cell.x, gy: cell.y, gz: z });
        }
      }
    }

    // Highlight the hovered tile with a bright outline.
    if (hover) {
      const p = hover;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.sx, p.sy - TH / 2);
      ctx.lineTo(p.sx + TW / 2, p.sy);
      ctx.lineTo(p.sx, p.sy + TH / 2);
      ctx.lineTo(p.sx - TW / 2, p.sy);
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
      // treat as a click: energize / de-energize the tile
      const [mx, my] = toInternal(ev);
      const p = pickAt(mx, my);
      if (p) {
        const k = key(p.gx, p.gy, p.gz);
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
      case "ArrowUp":    panY += 8; ev.preventDefault(); break;
      case "ArrowDown":  panY -= 8; ev.preventDefault(); break;
    }
  });

  requestAnimationFrame(render);
})();
