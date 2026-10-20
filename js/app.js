import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { decodeOb2, PALETTE } from './ob2.js';

const MAX_ROWS = 300;
const TYPE_LABEL = { loc: 'Object', npc: 'NPC', obj: 'Item', model: 'Model' };

const $ = (id) => document.getElementById(id);
const idInput = $('search-id');
const nameInput = $('search-name');
const tbody = $('results-body');
const countEl = $('result-count');
const infoEl = $('info');
const statusEl = $('viewer-status');

let index = [];
let textures = {};
let selectedRow = null;
const modelCache = new Map();

// ---------- viewer ----------

THREE.ColorManagement.enabled = false;

const viewerEl = $('viewer');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setClearColor(0x000000);
viewerEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 1, 200000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.zoomSpeed = 1.2;

scene.add(new THREE.AmbientLight(0xffffff, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 0.7);
sun.position.set(-1, 2, 1.5);
scene.add(sun);
const fill = new THREE.DirectionalLight(0xffffff, 0.3);
fill.position.set(1, -0.5, -1);
scene.add(fill);

let current = null;

function resize() {
    const w = viewerEl.clientWidth;
    const h = viewerEl.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewerEl);

(function loop() {
    requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
})();

const SHAPE_LABEL = {
    0: 'Straight wall', 1: 'Diagonal corner', 2: 'L corner', 3: 'Square corner', 4: 'Wall decor',
    5: 'Wall decor (offset)', 6: 'Diagonal decor (offset)', 7: 'Diagonal decor', 8: 'Diagonal decor (both)',
    9: 'Diagonal wall', 10: 'Object', 11: 'Object (diagonal)', 12: 'Roof', 13: 'Roof diagonal (edge)',
    14: 'Roof diagonal', 15: 'Roof L (concave)', 16: 'Roof L (convex)', 17: 'Flat roof', 18: 'Roof edge',
    19: 'Roof edge corner', 20: 'Roof edge L', 21: 'Roof edge square corner', 22: 'Ground decor'
};

const textureCache = new Map();

// load a game texture, turning its magenta (#ff00ff) pixels transparent like the game does
function loadTexture(id) {
    if (textureCache.has(id)) return textureCache.get(id);
    const promise = new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const c = document.createElement('canvas');
            c.width = img.width;
            c.height = img.height;
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const data = ctx.getImageData(0, 0, c.width, c.height);
            for (let i = 0; i < data.data.length; i += 4) {
                if (data.data[i] === 255 && data.data[i + 1] === 0 && data.data[i + 2] === 255) data.data[i + 3] = 0;
            }
            ctx.putImageData(data, 0, 0);
            const tex = new THREE.CanvasTexture(c);
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            tex.magFilter = THREE.NearestFilter;
            resolve(tex);
        };
        img.onerror = () => resolve(null);
        img.src = `textures/${id}.png`;
    });
    textureCache.set(id, promise);
    return promise;
}

const isTextured = (renderType) => (renderType & 3) >= 2;

// Work out where each corner of a textured face sits on the texture. The model gives three
// "texture points" (P, M, N): P is the texture's corner, P->M runs along its width and P->N
// along its height. Each face corner is projected onto that frame.
function textureUv(m, t, v) {
    const P = [m.x[m.tp[t]], m.y[m.tp[t]], m.z[m.tp[t]]];
    const M = [m.x[m.tm[t]], m.y[m.tm[t]], m.z[m.tm[t]]];
    const N = [m.x[m.tn[t]], m.y[m.tn[t]], m.z[m.tn[t]]];
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const U = sub(M, P);
    const V = sub(N, P);
    const n = cross(U, V);
    const cu = cross(V, n);
    const cv = cross(n, U);
    const d = sub([m.x[v], m.y[v], m.z[v]], P);
    const du = dot(U, cu);
    const dv = dot(V, cv);
    return [du ? dot(d, cu) / du : 0, dv ? 1 - dot(d, cv) / dv : 0];
}

function rgbOf(colour) {
    return PALETTE[colour & 0xffff];
}

function buildMesh(models, entry) {
    const scale = entry.sc || [128, 128, 128];
    const mirror = !!entry.mi;
    const opaque = { pos: [], col: [] };
    const trans = { pos: [], col: [] };
    const textured = new Map(); // texture id -> { pos, uv }

    for (const m of models) {
        // apply recolours/retextures in the same order the game does
        const colour = Int32Array.from(m.colour);
        for (const [src, dst] of entry.rc || []) {
            for (let f = 0; f < m.numFaces; f++) {
                if (!isTextured(m.renderType[f]) && colour[f] === src) colour[f] = dst;
            }
        }
        for (const [src, dst] of entry.rt || []) {
            for (let f = 0; f < m.numFaces; f++) {
                if (isTextured(m.renderType[f]) && colour[f] === src) colour[f] = dst;
            }
        }

        const place = (v) => {
            // game: y points down
            const px = (m.x[v] * scale[0]) / 128;
            const py = (-m.y[v] * scale[1]) / 128;
            let pz = (m.z[v] * scale[2]) / 128;
            if (mirror) pz = -pz;
            return [px, py, pz];
        };

        for (let f = 0; f < m.numFaces; f++) {
            const a = m.alpha[f];
            if (a >= 255) continue;
            const corners = [m.fa[f], m.fb[f], m.fc[f]];

            if (isTextured(m.renderType[f]) && textures[colour[f]]) {
                const t = m.renderType[f] >> 2;
                if (!textured.has(colour[f])) textured.set(colour[f], { pos: [], uv: [] });
                const bucket = textured.get(colour[f]);
                for (const v of corners) {
                    bucket.pos.push(...place(v));
                    bucket.uv.push(...(t < m.tp.length ? textureUv(m, t, v) : [0, 0]));
                }
                continue;
            }

            const target = a > 0 ? trans : opaque;
            const rgb = rgbOf(colour[f]);
            const r = ((rgb >> 16) & 0xff) / 255;
            const g = ((rgb >> 8) & 0xff) / 255;
            const b = (rgb & 0xff) / 255;
            for (const v of corners) {
                target.pos.push(...place(v));
                if (target === trans) target.col.push(r, g, b, 1 - a / 255);
                else target.col.push(r, g, b);
            }
        }
    }

    const group = new THREE.Group();
    const geometry = (pos) => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        return geo;
    };
    const addColoured = (bucket, transparent) => {
        if (!bucket.pos.length) return;
        const geo = geometry(bucket.pos);
        geo.setAttribute('color', new THREE.Float32BufferAttribute(bucket.col, transparent ? 4 : 3));
        geo.computeVertexNormals();
        const mat = new THREE.MeshLambertMaterial({
            vertexColors: true,
            side: THREE.DoubleSide,
            flatShading: true,
            transparent,
            depthWrite: !transparent
        });
        group.add(new THREE.Mesh(geo, mat));
    };
    addColoured(opaque, false);
    addColoured(trans, true);

    for (const [id, bucket] of textured) {
        const geo = geometry(bucket.pos);
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(bucket.uv, 2));
        geo.computeVertexNormals();
        const avg = textures[id].avg;
        const mat = new THREE.MeshLambertMaterial({
            color: new THREE.Color(avg[0] / 255, avg[1] / 255, avg[2] / 255), // shown until the texture loads
            side: THREE.DoubleSide,
            flatShading: true,
            alphaTest: 0.5
        });
        loadTexture(id).then((tex) => {
            if (!tex) return;
            mat.map = tex;
            mat.color.set(0xffffff);
            mat.needsUpdate = true;
        });
        group.add(new THREE.Mesh(geo, mat));
    }
    return group;
}

function frame(object) {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 1);
    const dist = r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));
    controls.target.copy(sphere.center);
    camera.position.copy(sphere.center).add(new THREE.Vector3(0.6, 0.45, -1).normalize().multiplyScalar(dist));
    camera.near = dist / 100;
    camera.far = dist * 100;
    camera.updateProjectionMatrix();
    controls.minDistance = r * 0.1;
    controls.maxDistance = dist * 20;
    controls.update();
}

async function loadModel(name) {
    if (modelCache.has(name)) return modelCache.get(name);
    const res = await fetch(`models/${encodeURIComponent(name)}.ob2`);
    if (!res.ok) throw new Error(`model ${name} not found`);
    const model = decodeOb2(new Uint8Array(await res.arrayBuffer()));
    modelCache.set(name, model);
    return model;
}

const variantsEl = $('variants');

async function show(entry, variant = 0) {
    renderInfo(entry);
    renderVariants(entry, variant);
    if (current) {
        scene.remove(current);
        current.traverse((o) => {
            o.geometry?.dispose();
            o.material?.dispose();
        });
        current = null;
    }
    const names = entry.v ? entry.v[variant][1] : entry.m;
    if (!names.length) {
        statusEl.textContent = 'This entry has no model.';
        return;
    }
    statusEl.textContent = 'Loading…';
    try {
        const models = await Promise.all(names.map(loadModel));
        current = buildMesh(models, entry);
        scene.add(current);
        frame(current);
        statusEl.textContent = '';
    } catch (e) {
        statusEl.textContent = e.message;
    }
}

// objects with more than one shape (walls, corners, roof pieces...) get a button per shape
function renderVariants(entry, active) {
    variantsEl.textContent = '';
    if (!entry.v) return;
    entry.v.forEach(([shape, models], i) => {
        const b = document.createElement('button');
        b.textContent = `${shape}: ${SHAPE_LABEL[shape] ?? 'shape ' + shape}`;
        b.title = models.join(', ');
        if (i === active) b.classList.add('active');
        b.addEventListener('click', () => show(entry, i));
        variantsEl.appendChild(b);
    });
}

// ---------- search ----------

function renderInfo(e) {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const rows = [
        ['Type', TYPE_LABEL[e.t]],
        ['ID', e.id],
        ['Name', e.name || '—'],
        ['Debug name', e.n],
        ['Models', e.v ? e.v.map(([shape, m]) => `${m.join(', ')} (shape ${shape})`).join(', ') : (e.m.length ? e.m.join(', ') : 'none')],
    ];
    if (e.rcs) rows.push(['Recolours', e.rcs.map(([s, d]) => `${s} → ${d}`).join(', ') + '  (as in the config file)']);
    if (e.rt) rows.push(['Retextures', e.rt.map(([s, d]) => `${s} → ${d}`).join(', ')]);
    if (e.sc) rows.push(['Scale', e.sc.join(' / ') + ' (128 = normal)']);
    if (e.mi) rows.push(['Mirrored', 'yes']);
    if (e.f) rows.push(['Defined in', e.f]);
    infoEl.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
}

function activeTypes() {
    return new Set([...document.querySelectorAll('.type-filter:checked')].map((c) => c.value));
}

function search() {
    const idText = idInput.value.trim();
    const nameText = nameInput.value.trim().toLowerCase();
    const types = activeTypes();
    const id = idText === '' ? null : Number(idText);

    const matches = [];
    for (const e of index) {
        if (!types.has(e.t)) continue;
        if (id !== null && e.id !== id) continue;
        if (nameText && !e.n.toLowerCase().includes(nameText) && !e.name.toLowerCase().includes(nameText)) continue;
        matches.push(e);
    }

    tbody.textContent = '';
    const frag = document.createDocumentFragment();
    matches.slice(0, MAX_ROWS).forEach((e, i) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td class="num">${i + 1}</td><td>${TYPE_LABEL[e.t]}</td><td class="num">${e.id}</td><td></td><td></td>`;
        tr.children[3].textContent = e.n;
        tr.children[4].textContent = e.name;
        if (!e.m.length) tr.classList.add('no-model');
        tr.addEventListener('click', () => {
            selectedRow?.classList.remove('selected');
            tr.classList.add('selected');
            selectedRow = tr;
            history.replaceState(null, '', `#${e.t}/${e.id}`);
            show(e);
        });
        frag.appendChild(tr);
    });
    tbody.appendChild(frag);

    countEl.textContent = matches.length > MAX_ROWS
        ? `${matches.length} matches (showing the first ${MAX_ROWS}, narrow your search)`
        : `${matches.length} match${matches.length === 1 ? '' : 'es'}`;
    return matches;
}

idInput.addEventListener('input', search);
nameInput.addEventListener('input', search);
document.querySelectorAll('.type-filter').forEach((c) => c.addEventListener('change', search));

// ---------- start ----------

(async () => {
    [index, textures] = await Promise.all([
        fetch('data/index.json').then((r) => r.json()),
        fetch('data/textures.json').then((r) => r.json())
    ]);
    $('loading').remove();

    if (!openFromHash()) search();
    window.addEventListener('hashchange', openFromHash);
})();

// open a link like #loc/2213
function openFromHash() {
    const m = location.hash.match(/^#(loc|npc|obj|model)\/(\d+)$/);
    if (!m) return false;
    const entry = index.find((e) => e.t === m[1] && e.id === Number(m[2]));
    if (!entry) return false;
    document.querySelectorAll('.type-filter').forEach((c) => (c.checked = c.value === m[1]));
    idInput.value = m[2];
    nameInput.value = '';
    search();
    tbody.firstElementChild?.click();
    return true;
}
