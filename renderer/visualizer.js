'use strict';

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const canvas       = document.getElementById('visCanvas');
const ctx          = canvas.getContext('2d');
const detailPanel  = document.getElementById('visDetail');
const detailInner  = document.getElementById('visDetailInner');
const statsEl      = document.getElementById('visStats');
const legendEl     = document.getElementById('visLegend');
const personaSel   = document.getElementById('visPersonaFilter');
const typeSel      = document.getElementById('visTypeFilter');
const showLabelsCk = document.getElementById('visShowLabels');

// ─── Data ─────────────────────────────────────────────────────────────────────
let allNodes = [], allLinks = [];
let nodes = [], links = [];
let nodeById = {};
let filterPersona = '', filterType = '';

// ─── Persona colours ──────────────────────────────────────────────────────────
const PALETTE = [
  '#00e5c8', '#0097ff', '#a855f7', '#f59e0b',
  '#10b981', '#ef4444', '#ec4899', '#84cc16',
  '#f97316', '#06b6d4',
];
const personaColors = {}, personaRgb = {};
let paletteIdx = 0;

function colorFor(persona) {
  const k = (persona || '').toLowerCase();
  if (!personaColors[k]) {
    personaColors[k] = PALETTE[paletteIdx++ % PALETTE.length];
    const h = personaColors[k].slice(1);
    personaRgb[k] = [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }
  return personaColors[k];
}

function rgba(persona, alpha) {
  colorFor(persona);
  const [r, g, b] = personaRgb[(persona || '').toLowerCase()];
  return `rgba(${r},${g},${b},${Math.max(0, alpha).toFixed(3)})`;
}

// ─── Orbit camera ─────────────────────────────────────────────────────────────
// Left-drag  = pan (translate look-at target in camera right/up plane)
// Right-drag = orbit (rotate theta/phi around target)
// Scroll     = zoom (change dist)
// Click node = detail panel
// Drag node  = move in camera-facing plane

const cam = {
  tx: 0, ty: 0, tz: 0,   // look-at target
  dist:  1000,            // distance from target
  theta: 0.5,             // azimuth  (rotation around Y)
  phi:   0.2,             // elevation (up/down tilt)
  fov:   600,             // focal length in px
};

const MIN_PHI  = -Math.PI / 2 + 0.05;
const MAX_PHI  =  Math.PI / 2 - 0.05;

// Derived basis vectors — recomputed in updateCam() each frame
let camPos   = [0, 0, 1000];
let camFwd   = [0, 0, -1];
let camRight = [1, 0, 0];
let camUp    = [0, 1, 0];

function updateCam() {
  const cosT = Math.cos(cam.theta), sinT = Math.sin(cam.theta);
  const cosP = Math.cos(cam.phi),   sinP = Math.sin(cam.phi);

  camPos = [
    cam.tx + cam.dist * cosP * sinT,
    cam.ty + cam.dist * sinP,
    cam.tz + cam.dist * cosP * cosT,
  ];

  // Forward = normalize(target − camPos)
  const fx = cam.tx - camPos[0], fy = cam.ty - camPos[1], fz = cam.tz - camPos[2];
  const fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
  camFwd = [fx / fl, fy / fl, fz / fl];

  // Right = normalize(cross(worldUp=[0,1,0], fwd))
  // cross([0,1,0], [fx,fy,fz]) = [1*fz−0*fy, 0*fx−0*fz, 0*fy−1*fx] = [fz, 0, −fx]
  // BUT we want right to point right when looking down -Z (theta=0, phi=0).
  // Test: fwd=[0,0,-1] → [fz,0,-fx] = [-1,0,0] — that's LEFT.
  // So we negate: right = [-fz, 0, fx] = cross(fwd, worldUp)
  const rl = Math.sqrt(fz * fz + fx * fx) || 1;
  camRight = [-fz / rl, 0, fx / rl];

  // Up = cross(right, fwd)
  camUp = [
    camRight[1] * camFwd[2] - camRight[2] * camFwd[1],
    camRight[2] * camFwd[0] - camRight[0] * camFwd[2],
    camRight[0] * camFwd[1] - camRight[1] * camFwd[0],
  ];
}

// Project 3D world point → screen. Returns null if behind camera.
function project(wx, wy, wz) {
  const dx = wx - camPos[0], dy = wy - camPos[1], dz = wz - camPos[2];
  const vx = dx * camRight[0] + dy * camRight[1] + dz * camRight[2];
  const vy = dx * camUp[0]    + dy * camUp[1]    + dz * camUp[2];
  const vz = dx * camFwd[0]   + dy * camFwd[1]   + dz * camFwd[2];
  if (vz < 0.5) return null;
  return {
    sx:    canvas.width  / 2 + (vx / vz) * cam.fov,
    sy:    canvas.height / 2 - (vy / vz) * cam.fov,   // Y flipped for screen
    depth: vz,
    scale: cam.fov / vz,
  };
}

// ─── 3D Force simulation ──────────────────────────────────────────────────────
const K_REPEL  = 9000;
const K_SPRING = 0.04;
const REST_LEN = 150;
const DAMPING  = 0.80;
const GRAVITY  = 0.012;

let simAlpha   = 1.0;
let simRunning = false;

function resetSim() { simAlpha = 1.0; simRunning = true; }

function tick() {
  if (simAlpha < 0.002) { simRunning = false; return; }
  simAlpha *= 0.994;
  const n = nodes.length;

  // Reset forces
  for (const nd of nodes) { nd.fx = 0; nd.fy = 0; nd.fz = 0; }

  // Repulsion (O(n²), fine up to ~400 nodes)
  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < n; j++) {
      const b  = nodes[j];
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const d2 = dx * dx + dy * dy + dz * dz + 1;
      const d  = Math.sqrt(d2);
      const f  = (K_REPEL / d2) * simAlpha;
      const fx = f * dx / d, fy = f * dy / d, fz = f * dz / d;
      a.fx -= fx; a.fy -= fy; a.fz -= fz;
      b.fx += fx; b.fy += fy; b.fz += fz;
    }
  }

  // Spring attraction along links
  for (const lk of links) {
    const a = nodeById[lk.from_id], b = nodeById[lk.to_id];
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const d  = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const f  = K_SPRING * (d - REST_LEN) * lk.strength * simAlpha;
    const fx = f * dx / d, fy = f * dy / d, fz = f * dz / d;
    a.fx += fx; a.fy += fy; a.fz += fz;
    b.fx -= fx; b.fy -= fy; b.fz -= fz;
  }

  // Gravity toward origin
  for (const nd of nodes) {
    nd.fx -= GRAVITY * nd.x * simAlpha;
    nd.fy -= GRAVITY * nd.y * simAlpha;
    nd.fz -= GRAVITY * nd.z * simAlpha;
  }

  // Integrate velocities (skip pinned nodes)
  for (const nd of nodes) {
    if (nd.pinned) continue;
    nd.vel_x = (nd.vel_x + nd.fx) * DAMPING;
    nd.vel_y = (nd.vel_y + nd.fy) * DAMPING;
    nd.vel_z = (nd.vel_z + nd.fz) * DAMPING;
    nd.x += nd.vel_x;
    nd.y += nd.vel_y;
    nd.z += nd.vel_z;
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────
let hoveredNode = null;

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  if (canvas.width !== rect.width || canvas.height !== rect.height) {
    canvas.width  = rect.width;
    canvas.height = rect.height;
  }
}

function draw() {
  resizeCanvas();
  updateCam();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Reference plane — dots on y = 0 grid
  {
    const STEP = 120, EXT = 900;
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    for (let gx = -EXT; gx <= EXT; gx += STEP) {
      for (let gz = -EXT; gz <= EXT; gz += STEP) {
        const p = project(gx, 0, gz);
        if (p && p.depth < cam.dist * 3) {
          ctx.beginPath();
          ctx.arc(p.sx, p.sy, Math.max(0.8, 1.5 * p.scale), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  // Edges
  for (const lk of links) {
    const a = nodeById[lk.from_id], b = nodeById[lk.to_id];
    if (!a || !b) continue;
    const pa = project(a.x, a.y, a.z), pb = project(b.x, b.y, b.z);
    if (!pa || !pb) continue;
    const fog = Math.min(1, cam.fov / ((pa.depth + pb.depth) / 2));
    ctx.beginPath();
    ctx.moveTo(pa.sx, pa.sy);
    ctx.lineTo(pb.sx, pb.sy);
    ctx.strokeStyle = `rgba(200,196,188,${(lk.strength * 0.28 * fog).toFixed(3)})`;
    ctx.lineWidth   = Math.max(0.5, lk.strength * 2.2 * fog);
    ctx.stroke();
  }

  // Nodes — sorted farthest-first (painter's algorithm)
  const showLabels = showLabelsCk.checked;
  const projected  = [];
  for (const nd of nodes) {
    const proj = project(nd.x, nd.y, nd.z);
    if (proj) projected.push({ nd, proj });
  }
  projected.sort((a, b) => b.proj.depth - a.proj.depth);

  for (const { nd, proj } of projected) {
    const { sx, sy, depth, scale } = proj;
    const fog   = Math.min(1.0, Math.max(0.1, cam.fov / depth));
    const r     = Math.max(3, nd.r * Math.min(scale * 0.85, 1.4));
    const isHov = nd === hoveredNode;

    // Halo
    if (isHov) {
      ctx.beginPath();
      ctx.arc(sx, sy, r + 8 * fog, 0, Math.PI * 2);
      ctx.fillStyle = rgba(nd.left_by, 0.18 * fog);
      ctx.fill();
    }

    // Reef ring
    if (nd.posted_to_reef) {
      ctx.beginPath();
      ctx.arc(sx, sy, r + 2.5, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(nd.left_by, 0.38 * fog);
      ctx.lineWidth   = 1;
      ctx.stroke();
    }

    // Node circle
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle   = rgba(nd.left_by, (isHov ? 1.0 : 0.75) * fog);
    ctx.fill();
    ctx.strokeStyle = isHov ? rgba(nd.left_by, fog) : `rgba(255,255,255,${(fog * 0.13).toFixed(3)})`;
    ctx.lineWidth   = isHov ? 1.5 : 0.5;
    ctx.stroke();

    // Label
    if (showLabels && (scale > 0.42 || isHov)) {
      const raw   = nd.title || nd.subject || nd.type || nd.left_by;
      const label = String(raw).slice(0, 26);
      const fs    = Math.max(8, Math.round(10 * Math.min(scale * 0.85, 1)));
      ctx.font      = `${fs}px JetBrains Mono, monospace`;
      ctx.textAlign = 'center';
      ctx.fillStyle = `rgba(200,196,188,${(fog * (isHov ? 0.9 : 0.42)).toFixed(3)})`;
      ctx.fillText(label, sx, sy + r + fs + 1);
    }
  }
}

// ─── Animation loop ───────────────────────────────────────────────────────────
function animate() {
  if (simRunning) tick();
  draw();
  requestAnimationFrame(animate);
}

// ─── Data loading ─────────────────────────────────────────────────────────────
async function loadGraph() {
  statsEl.textContent = '— loading —';
  try {
    const res = await window.reef.invoke('memory.graph', { limit: 400 });
    if (!res.ok) throw new Error(res.error);
    allNodes = res.result.nodes;
    allLinks = res.result.links;
    buildFilterOptions();
    applyFilter();
  } catch (e) {
    statsEl.textContent = `error: ${e.message}`;
    console.error('[visualizer]', e);
  }
}

function buildFilterOptions() {
  const personas = [...new Set(allNodes.map(n => n.left_by))].sort();
  const types    = [...new Set(allNodes.map(n => n.type))].sort();
  for (const p of personas) {
    const o = document.createElement('option');
    o.value = p; o.textContent = p.toUpperCase();
    personaSel.appendChild(o);
  }
  for (const t of types) {
    const o = document.createElement('option');
    o.value = t; o.textContent = t.toUpperCase();
    typeSel.appendChild(o);
  }
  buildLegend(personas);
}

function buildLegend(personas) {
  legendEl.innerHTML = '';
  for (const p of personas) {
    const el = document.createElement('div');
    el.className = 'vis-legend-item';
    el.innerHTML = `<span class="vis-legend-dot" style="background:${colorFor(p)}"></span><span>${p}</span>`;
    legendEl.appendChild(el);
  }
}

function applyFilter() {
  nodes = allNodes.filter(n =>
    (!filterPersona || n.left_by === filterPersona) &&
    (!filterType    || n.type    === filterType)
  );
  const nodeSet = new Set(nodes.map(n => n.id));
  links = allLinks.filter(l => nodeSet.has(l.from_id) && nodeSet.has(l.to_id));

  // Degree
  const degree = {};
  for (const n of nodes) degree[n.id] = 0;
  for (const l of links) {
    degree[l.from_id] = (degree[l.from_id] || 0) + 1;
    degree[l.to_id]   = (degree[l.to_id]   || 0) + 1;
  }

  // Initialise simulation state — preserve positions across filter changes
  for (const n of nodes) {
    if (n.x === undefined) {
      // Sphere-surface distribution for a nicer initial spread in 3D
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      const rad   = 300 + Math.random() * 450;
      n.x = rad * Math.sin(phi) * Math.cos(theta);
      n.y = rad * Math.sin(phi) * Math.sin(theta);
      n.z = rad * Math.cos(phi);
      n.vel_x = n.vel_y = n.vel_z = 0;
    }
    n.r  = Math.max(6, Math.min(20, 6 + (degree[n.id] || 0) * 2));
    n.fx = n.fy = n.fz = 0;
  }

  nodeById = {};
  for (const n of nodes) nodeById[n.id] = n;
  statsEl.textContent = `${nodes.length} nodes · ${links.length} links`;
  resetSim();
}

// ─── Hit test ────────────────────────────────────────────────────────────────
function nodeAtScreen(sx, sy) {
  let best = null, bestDepth = Infinity;
  for (const nd of nodes) {
    const proj = project(nd.x, nd.y, nd.z);
    if (!proj) continue;
    const rScr = Math.max(6, nd.r * Math.min(proj.scale * 0.85, 1.4)) + 5;
    const dx   = sx - proj.sx, dy = sy - proj.sy;
    if (dx * dx + dy * dy <= rScr * rScr && proj.depth < bestDepth) {
      bestDepth = proj.depth;
      best = nd;
    }
  }
  return best;
}

// ─── Mouse / interaction ─────────────────────────────────────────────────────
let isDragging    = false;           // left-drag on empty = pan
let isRotating    = false;           // right-drag = orbit
let dragMX = 0,   dragMY = 0;        // pan drag start
let dragTX = 0,   dragTY = 0, dragTZ = 0;   // pan target start
let rotMX  = 0,   rotMY = 0;         // orbit drag start
let rotTheta0 = 0, rotPhi0 = 0;      // orbit angle start

let draggingNode   = null;           // left-drag on node
let dragNodeDepth  = 0;              // camera-space depth of dragged node
let nodeWasDragged = false;          // distinguish click from drag

// Prevent right-click context menu
canvas.addEventListener('contextmenu', e => e.preventDefault());

canvas.addEventListener('mousedown', e => {
  e.preventDefault();

  if (e.button === 2) {
    // Right button → orbit
    isRotating = true;
    rotMX      = e.clientX;
    rotMY      = e.clientY;
    rotTheta0  = cam.theta;
    rotPhi0    = cam.phi;
    return;
  }

  if (e.button === 0) {
    const nd = nodeAtScreen(e.offsetX, e.offsetY);
    if (nd) {
      // Drag a node in the camera-facing plane
      draggingNode   = nd;
      nodeWasDragged = false;
      nd.pinned      = true;
      nd.vel_x = nd.vel_y = nd.vel_z = 0;
      const proj    = project(nd.x, nd.y, nd.z);
      dragNodeDepth = proj ? proj.depth : cam.dist;
    } else {
      // Pan
      isDragging = true;
      dragMX = e.clientX; dragMY = e.clientY;
      dragTX = cam.tx;    dragTY = cam.ty;    dragTZ = cam.tz;
    }
  }
});

canvas.addEventListener('mousemove', e => {
  hoveredNode = nodeAtScreen(e.offsetX, e.offsetY);

  // ── Orbit (right-drag) ─────────────────────────────────────────────────────
  if (isRotating) {
    cam.theta = rotTheta0 + (e.clientX - rotMX) * 0.005;
    cam.phi   = Math.max(MIN_PHI, Math.min(MAX_PHI,
                  rotPhi0 - (e.clientY - rotMY) * 0.005));
    canvas.style.cursor = 'grabbing';
    return;
  }

  // ── Node drag ─────────────────────────────────────────────────────────────
  if (draggingNode) {
    const hw = canvas.width  / 2;
    const hh = canvas.height / 2;
    const d  = dragNodeDepth;
    // Unproject screen position back to world at the same camera-space depth
    const cx3 =  (e.offsetX - hw) / cam.fov * d;
    const cy3 = -(e.offsetY - hh) / cam.fov * d;   // flip Y
    draggingNode.x = camPos[0] + cx3 * camRight[0] + cy3 * camUp[0] + d * camFwd[0];
    draggingNode.y = camPos[1] + cx3 * camRight[1] + cy3 * camUp[1] + d * camFwd[1];
    draggingNode.z = camPos[2] + cx3 * camRight[2] + cy3 * camUp[2] + d * camFwd[2];
    draggingNode.vel_x = draggingNode.vel_y = draggingNode.vel_z = 0;
    nodeWasDragged = true;
    if (!simRunning) resetSim();
    canvas.style.cursor = 'grabbing';
    return;
  }

  // ── Pan (left-drag on empty space) ────────────────────────────────────────
  if (isDragging) {
    // 1 pixel = dist/fov world units at the camera's target depth
    const scale = cam.dist / cam.fov;
    const ddx   = e.clientX - dragMX;
    const ddy   = e.clientY - dragMY;
    // Move target opposite to mouse so the world follows the cursor
    cam.tx = dragTX - ddx * scale * camRight[0] + ddy * scale * camUp[0];
    cam.ty = dragTY - ddx * scale * camRight[1] + ddy * scale * camUp[1];
    cam.tz = dragTZ - ddx * scale * camRight[2] + ddy * scale * camUp[2];
    canvas.style.cursor = 'grabbing';
    return;
  }

  canvas.style.cursor = hoveredNode ? 'pointer' : 'grab';
});

canvas.addEventListener('mouseup', e => {
  if (e.button === 2) {
    isRotating = false;
  } else if (e.button === 0) {
    if (draggingNode) {
      if (!nodeWasDragged) showDetail(draggingNode);
      draggingNode.pinned = false;
      draggingNode = null;
    }
    isDragging = false;
  }
  canvas.style.cursor = hoveredNode ? 'pointer' : 'grab';
});

canvas.addEventListener('mouseleave', () => {
  isDragging = isRotating = false;
  if (draggingNode) { draggingNode.pinned = false; draggingNode = null; }
  hoveredNode = null;
});

// Zoom — toward mouse-under cursor in world space
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  cam.dist = Math.max(80, Math.min(5000, cam.dist * (e.deltaY < 0 ? 0.9 : 1.1)));
}, { passive: false });

// ─── Detail panel ─────────────────────────────────────────────────────────────
function showDetail(nd) {
  const ts    = new Date(nd.created_at).toLocaleDateString('en-CA');
  const color = colorFor(nd.left_by);
  const tags  = (nd.tags || []).map(t => `<span class="card-tag">${esc(t)}</span>`).join('');
  const reef  = nd.posted_to_reef
    ? `<span class="card-type" style="color:var(--accent);border-color:rgba(0,229,200,0.3)">REEF</span>` : '';

  detailInner.innerHTML = `
    <div class="vis-detail-persona" style="color:${color}">${esc(nd.left_by).toUpperCase()}</div>
    <div class="vis-detail-meta">
      <span class="card-type">${esc(nd.type)}</span>
      <span class="card-date">${ts}</span>
      ${reef}
    </div>
    ${nd.title   ? `<div class="vis-detail-title">${esc(nd.title)}</div>`   : ''}
    ${nd.subject ? `<div class="vis-detail-subject">${esc(nd.subject)}</div>` : ''}
    <div class="vis-detail-body">${esc(nd.body)}</div>
    ${tags ? `<div class="card-tags" style="margin-top:10px">${tags}</div>` : ''}
    <div class="vis-detail-links" id="visDetailLinks"></div>
  `;

  // Connection list
  const conns = links
    .filter(l => l.from_id === nd.id || l.to_id === nd.id)
    .map(l => ({
      lk:    l,
      other: nodeById[l.from_id === nd.id ? l.to_id : l.from_id],
      dir:   l.from_id === nd.id ? '→' : '←',
    }))
    .filter(x => x.other);

  if (conns.length) {
    const div = document.getElementById('visDetailLinks');
    div.innerHTML = `<div class="vis-detail-links-title">CONNECTIONS (${conns.length})</div>`;
    for (const { lk, other, dir } of conns.slice(0, 12)) {
      const c    = colorFor(other.left_by);
      const name = esc((other.title || other.subject || other.type || '').slice(0, 42));
      const item = document.createElement('div');
      item.className  = 'vis-detail-link-item';
      item.dataset.id = other.id;
      item.innerHTML  = `<span style="color:${c}">${esc(other.left_by)}</span> `
        + `${dir} <em style="opacity:0.55">${esc(lk.relationship)}</em> `
        + `<span style="opacity:0.4">${lk.strength.toFixed(2)}</span> — ${name}`;
      div.appendChild(item);
    }
    div.querySelectorAll('[data-id]').forEach(el => {
      el.addEventListener('click', () => {
        const t = nodeById[Number(el.dataset.id)];
        if (t) { cam.tx = t.x; cam.ty = t.y; cam.tz = t.z; showDetail(t); }
      });
    });
  }

  detailPanel.style.display = '';
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

document.getElementById('visDetailClose').addEventListener('click', () => {
  detailPanel.style.display = 'none';
});

// ─── Controls ─────────────────────────────────────────────────────────────────
personaSel.addEventListener('change', e => { filterPersona = e.target.value; applyFilter(); });
typeSel.addEventListener('change',    e => { filterType    = e.target.value; applyFilter(); });

document.getElementById('visResetBtn').addEventListener('click', () => {
  cam.tx = 0; cam.ty = 0; cam.tz = 0;
  cam.theta = 0.5; cam.phi = 0.2; cam.dist = 1000;
});

document.getElementById('visExportBtn').addEventListener('click', () => {
  const a  = document.createElement('a');
  a.download = `reef-graph-${Date.now()}.png`;
  a.href     = canvas.toDataURL('image/png');
  a.click();
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
loadGraph();
animate();
