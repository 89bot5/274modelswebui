// Decoder for RuneScape 2 (2004) .ob2 model files.
// Ported from the Lost City web client's Model.unpack/Model.load (src/dash3d/Model.ts).

class Reader {
    constructor(bytes, pos) {
        this.b = bytes;
        this.pos = pos;
    }
    g1() {
        return this.b[this.pos++];
    }
    g2() {
        const v = (this.b[this.pos] << 8) | this.b[this.pos + 1];
        this.pos += 2;
        return v;
    }
    gsmarts() {
        return this.b[this.pos] < 0x80 ? this.g1() - 0x40 : this.g2() - 0xc000;
    }
}

export function decodeOb2(bytes) {
    const t = new Reader(bytes, bytes.length - 18);
    const numPoints = t.g2();
    const numFaces = t.g2();
    const numT = t.g1();
    const hasRenderType = t.g1();
    const priority = t.g1();
    const hasAlpha = t.g1();
    const hasFaceLabels = t.g1();
    const hasVertexLabels = t.g1();
    const lenX = t.g2();
    const lenY = t.g2();
    const lenZ = t.g2();
    const lenFaceIndex = t.g2();

    let pos = 0;
    const vertexOrderOffset = pos;
    pos += numPoints;
    const faceIndexOrderOffset = pos;
    pos += numFaces;
    if (priority === 255) pos += numFaces;
    if (hasFaceLabels === 1) pos += numFaces;
    const faceRenderTypeOffset = hasRenderType === 1 ? pos : -1;
    if (hasRenderType === 1) pos += numFaces;
    if (hasVertexLabels === 1) pos += numPoints;
    const faceAlphaOffset = hasAlpha === 1 ? pos : -1;
    if (hasAlpha === 1) pos += numFaces;
    const faceIndexOffset = pos;
    pos += lenFaceIndex;
    const faceColourOffset = pos;
    pos += numFaces * 2;
    pos += numT * 6; // texture axes, not needed for flat viewing
    const vertexXOffset = pos;
    pos += lenX;
    const vertexYOffset = pos;
    pos += lenY;
    const vertexZOffset = pos;

    const x = new Int32Array(numPoints);
    const y = new Int32Array(numPoints);
    const z = new Int32Array(numPoints);
    const order = new Reader(bytes, vertexOrderOffset);
    const rx = new Reader(bytes, vertexXOffset);
    const ry = new Reader(bytes, vertexYOffset);
    const rz = new Reader(bytes, vertexZOffset);
    let dx = 0, dy = 0, dz = 0;
    for (let v = 0; v < numPoints; v++) {
        const o = order.g1();
        x[v] = dx + ((o & 1) ? rx.gsmarts() : 0);
        y[v] = dy + ((o & 2) ? ry.gsmarts() : 0);
        z[v] = dz + ((o & 4) ? rz.gsmarts() : 0);
        dx = x[v];
        dy = y[v];
        dz = z[v];
    }

    const colour = new Int32Array(numFaces);
    const renderType = new Int32Array(numFaces);
    const alpha = new Int32Array(numFaces);
    const rc = new Reader(bytes, faceColourOffset);
    const rt = new Reader(bytes, faceRenderTypeOffset);
    const ra = new Reader(bytes, faceAlphaOffset);
    for (let f = 0; f < numFaces; f++) {
        colour[f] = rc.g2();
        if (faceRenderTypeOffset >= 0) renderType[f] = rt.g1();
        if (faceAlphaOffset >= 0) alpha[f] = ra.g1();
    }

    const fa = new Int32Array(numFaces);
    const fb = new Int32Array(numFaces);
    const fc = new Int32Array(numFaces);
    const vi = new Reader(bytes, faceIndexOffset);
    const vo = new Reader(bytes, faceIndexOrderOffset);
    let a = 0, b = 0, c = 0, last = 0;
    for (let f = 0; f < numFaces; f++) {
        const type = vo.g1();
        if (type === 1) {
            a = vi.gsmarts() + last;
            b = vi.gsmarts() + a;
            c = vi.gsmarts() + b;
            last = c;
        } else if (type === 2) {
            b = c;
            c = vi.gsmarts() + last;
            last = c;
        } else if (type === 3) {
            a = c;
            c = vi.gsmarts() + last;
            last = c;
        } else if (type === 4) {
            const tmp = a;
            a = b;
            b = tmp;
            c = vi.gsmarts() + last;
            last = c;
        }
        fa[f] = a;
        fb[f] = b;
        fc[f] = c;
    }

    return { numPoints, numFaces, x, y, z, fa, fb, fc, colour, renderType, alpha };
}

// The game's 16-bit HSL colour -> RGB table (Pix3D.initColourTable), at the client's default brightness.
export const PALETTE = (() => {
    const brightness = 0.8;
    const table = new Int32Array(65536);
    let offset = 0;
    for (let yy = 0; yy < 512; yy++) {
        const hue = ((yy / 8) | 0) / 64.0 + 0.0078125;
        const sat = (yy & 7) / 8.0 + 0.0625;
        for (let xx = 0; xx < 128; xx++) {
            const light = xx / 128.0;
            let r = light, g = light, b = light;
            if (sat !== 0) {
                const q = light < 0.5 ? light * (sat + 1) : light + sat - light * sat;
                const p = light * 2 - q;
                let tr = hue + 1 / 3;
                if (tr > 1) tr--;
                let tb = hue - 1 / 3;
                if (tb < 0) tb++;
                const ch = (t) => {
                    if (t * 6 < 1) return p + (q - p) * 6 * t;
                    if (t * 2 < 1) return q;
                    if (t * 3 < 2) return p + (q - p) * (2 / 3 - t) * 6;
                    return p;
                };
                r = ch(tr);
                g = ch(hue);
                b = ch(tb);
            }
            const gamma = (v) => Math.min(255, (Math.pow(((v * 256) | 0) / 256, brightness) * 256) | 0);
            table[offset++] = (gamma(r) << 16) | (gamma(g) << 8) | gamma(b);
        }
    }
    return table;
})();
