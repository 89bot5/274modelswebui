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

function rgbOf(colour, renderType) {
    if (renderType & 2) {
        const t = textures[colour];
        return t ? (t[0] << 16) | (t[1] << 8) | t[2] : 0x808080;
    }
    return PALETTE[colour & 0xffff];
}

function buildMesh(models, entry) {
    const scale = entry.sc || [128, 128, 128];
    const mirror = !!entry.mi;
    const opaque = { pos: [], col: [] };
    const trans = { pos: [], col: [] };

    for (const m of models) {
        // apply recolours in the same order the game does
        const colour = Int32Array.from(m.colour);
        for (const [src, dst] of entry.rc || []) {
            for (let f = 0; f < m.numFaces; f++) {
                if (!(m.renderType[f] & 2) && colour[f] === src) colour[f] = dst;
            }
        }
        for (const [src, dst] of entry.rt || []) {
            for (let f = 0; f < m.numFaces; f++) {
                if ((m.renderType[f] & 2) && colour[f] === src) colour[f] = dst;
            }
        }

        for (let f = 0; f < m.numFaces; f++) {
            const a = m.alpha[f];
            if (a >= 255) continue;
            const target = a > 0 ? trans : opaque;
            const rgb = rgbOf(colour[f], m.renderType[f]);
            const r = ((rgb >> 16) & 0xff) / 255;
            const g = ((rgb >> 8) & 0xff) / 255;
            const b = (rgb & 0xff) / 255;
            for (const v of [m.fa[f], m.fb[f], m.fc[f]]) {
                // game: y points down, z forward
                const px = (m.x[v] * scale[0]) / 128;
                const py = (-m.y[v] * scale[1]) / 128;
                let pz = (m.z[v] * scale[2]) / 128;
                if (mirror) pz = -pz;
                target.pos.push(px, py, pz);
                if (target === trans) target.col.push(r, g, b, 1 - a / 255);
                else target.col.push(r, g, b);
            }
        }
    }

    const group = new THREE.Group();
    const add = (bucket, transparent) => {
        if (!bucket.pos.length) return;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(bucket.pos, 3));
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
    add(opaque, false);
    add(trans, true);
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

async function show(entry) {
    renderInfo(entry);
    if (current) {
        scene.remove(current);
        current.traverse((o) => {
            o.geometry?.dispose();
            o.material?.dispose();
        });
        current = null;
    }
    if (!entry.m.length) {
        statusEl.textContent = 'This entry has no model.';
        return;
    }
    statusEl.textContent = 'Loading…';
    try {
        const models = await Promise.all(entry.m.map(loadModel));
        current = buildMesh(models, entry);
        scene.add(current);
        frame(current);
        statusEl.textContent = '';
    } catch (e) {
        statusEl.textContent = e.message;
    }
}

// ---------- search ----------

function renderInfo(e) {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const rows = [
        ['Type', TYPE_LABEL[e.t]],
        ['ID', e.id],
        ['Name', e.name || '—'],
        ['Debug name', e.n],
        ['Models', e.m.length ? e.m.join(', ') : 'none'],
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
