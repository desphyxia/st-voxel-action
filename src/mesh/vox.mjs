/**
 * MagicaVoxel .vox models — issue #34.
 *
 * The art pipeline is hybrid (`docs/DECISIONS.md` §7): trees, boulders, walls
 * and clutter are procedural, and characters, creatures and hero structures
 * are authored by hand in MagicaVoxel. This is the reader for the second half,
 * and a writer, because the first model is authored by a script
 * (tools/author-hero.mjs) and has to come out as a file MagicaVoxel opens.
 *
 * A file is RIFF-like: "VOX ", a version, then a MAIN chunk whose children
 * are what matters here —
 *
 *   SIZE, XYZI   one pair per model: its extent, then (x, y, z, colour) bytes
 *   RGBA         the 256-colour palette; colour index i is entry i - 1
 *   nTRN/nGRP/nSHP  the scene graph, which is where a model's *name* lives
 *
 * Models are matched to what they dress by name, never by order: MagicaVoxel
 * keeps the names a person gave the parts, and does not promise the order.
 *
 * Colour is not carried. A model's palette index is mapped onto the palette
 * table and the material table (a role, below) the same way a generated voxel
 * is — #28's argument, that restyling must not mean re-authoring, holds for a
 * character as much as for a hillside.
 *
 * Axes: MagicaVoxel is z-up. Here x stays x, the file's z is up (y), and the
 * file's y runs backwards into z — a rotation, not a mirror, so a left arm
 * authored as a left arm stays one.
 */
import { MAT } from '../gen/materials.mjs';
import { PAL } from '../gen/palette.mjs';

/** Metres per model voxel: a character is finer than the 25 cm terrain grid. */
export const VOX_SCALE = 0.0625;

/**
 * What each colour index of the hero model means (#34). `tint` names the
 * per-player colour the rig already takes ('cloth', 'skin'), scaled by `k`;
 * otherwise `pal` names a palette group. `mat` is the material table's word
 * for it — what a blade sounds like when it hits, and what it is made of.
 */
export const HERO_VOX_ROLES = {
  1: { tint: 'cloth', k: 1, mat: MAT.CLOTH },
  2: { tint: 'cloth', k: 0.74, mat: MAT.CLOTH },
  3: { tint: 'skin', k: 1, mat: MAT.FLESH },
  4: { tint: 'skin', k: 0.82, mat: MAT.FLESH },
  5: { pal: 'HERO_HAIR', mat: MAT.CLOTH },
  6: { pal: 'HERO_LEATHER', mat: MAT.CLOTH },
  7: { pal: 'HERO_BOOT', mat: MAT.CLOTH },
  8: { pal: 'HERO_TROUSER', mat: MAT.CLOTH },
  9: { pal: 'HERO_CANVAS', mat: MAT.CLOTH },
  10: { pal: 'HERO_EYE', mat: MAT.FLESH },
  11: { pal: 'HERO_IRON', mat: MAT.METAL },
  12: { pal: 'HERO_STEEL', mat: MAT.METAL },
  13: { pal: 'HERO_MARK', mat: MAT.METAL },
};

function tag(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }

/**
 * Bytes to models. Returns { version, models: [{ name, size: [x, y, z],
 * xyzi: Uint8Array }], palette: Uint32Array(256) as 0xRRGGBB, index 1 first }.
 */
export function parseVox(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 20 || tag(b, 0) !== 'VOX ' || tag(b, 8) !== 'MAIN') throw new Error('not a .vox file');
  const version = dv.getInt32(4, true);
  const models = [], palette = new Uint32Array(256), shapes = {}, trns = {};
  let size = null, o = 20 + dv.getInt32(12, true);
  const end = o + dv.getInt32(16, true);
  const str = (p) => { const n = dv.getInt32(p, true); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[p + 4 + i]); return [s, p + 4 + n]; };
  const dict = (p) => {
    const n = dv.getInt32(p, true), d = {}; p += 4;
    for (let i = 0; i < n; i++) { const [k, p1] = str(p); const [v, p2] = str(p1); d[k] = v; p = p2; }
    return [d, p];
  };
  for (let i = 0; i < 256; i++) palette[i] = 0x808080;
  while (o + 12 <= end) {
    const id = tag(b, o), n = dv.getInt32(o + 4, true), c = dv.getInt32(o + 8, true), p = o + 12;
    if (id === 'SIZE') size = [dv.getInt32(p, true), dv.getInt32(p + 4, true), dv.getInt32(p + 8, true)];
    else if (id === 'XYZI') {
      const k = dv.getInt32(p, true);
      models.push({ name: null, size, xyzi: b.slice(p + 4, p + 4 + 4 * k) });
    } else if (id === 'RGBA') {
      for (let i = 0; i < 255; i++) palette[i + 1] = (b[p + i * 4] << 16) | (b[p + i * 4 + 1] << 8) | b[p + i * 4 + 2];
    } else if (id === 'nTRN') {
      const node = dv.getInt32(p, true), [attr, p1] = dict(p + 4);
      trns[node] = { name: attr._name || null, child: dv.getInt32(p1, true) };
    } else if (id === 'nSHP') {
      const node = dv.getInt32(p, true), [, p1] = dict(p + 4);
      if (dv.getInt32(p1, true) > 0) shapes[node] = dv.getInt32(p1 + 4, true);
    }
    o = p + n + c;
  }
  for (const k in trns) {
    const t = trns[k], m = shapes[t.child];
    if (t.name && m !== undefined && models[m]) models[m].name = t.name;
  }
  return { version, models, palette };
}

/**
 * Models to bytes: the chunks MagicaVoxel writes, with a scene graph that
 * names each model and lays them out side by side so they can be told apart
 * when the file is opened.
 */
export function writeVox(v) {
  const out = [];
  const i32 = (n) => { out.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255); };
  const s4 = (s) => { for (let i = 0; i < 4; i++) out.push(s.charCodeAt(i)); };
  const bytesOf = (fill) => { const save = out.length; fill(); return out.splice(save); };
  const chunk = (id, body) => { s4(id); i32(body.length); i32(0); for (const x of body) out.push(x); };
  const str = (s) => { i32(s.length); for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); };
  const dict = (d) => { const k = Object.keys(d); i32(k.length); for (const q of k) { str(q); str(String(d[q])); } };

  const kids = bytesOf(() => {
    v.models.forEach((m) => {
      chunk('SIZE', bytesOf(() => { i32(m.size[0]); i32(m.size[1]); i32(m.size[2]); }));
      chunk('XYZI', bytesOf(() => { i32(m.xyzi.length / 4); for (const x of m.xyzi) out.push(x); }));
    });
    const n = v.models.length;
    chunk('nTRN', bytesOf(() => { i32(0); dict({}); i32(1); i32(-1); i32(-1); i32(1); dict({}); }));
    chunk('nGRP', bytesOf(() => { i32(1); dict({}); i32(n); for (let i = 0; i < n; i++) i32(2 + i * 2); }));
    let x = 0;
    v.models.forEach((m, i) => {
      const tx = Math.round(x + m.size[0] / 2);
      x += m.size[0] + 2;
      chunk('nTRN', bytesOf(() => {
        i32(2 + i * 2); dict(m.name ? { _name: m.name } : {}); i32(3 + i * 2); i32(-1); i32(0); i32(1);
        dict({ _t: `${tx} 0 ${Math.round(m.size[2] / 2)}` });
      }));
      chunk('nSHP', bytesOf(() => { i32(3 + i * 2); dict({}); i32(1); i32(i); dict({}); }));
    });
    chunk('RGBA', bytesOf(() => {
      for (let i = 1; i <= 256; i++) {
        const c = i < 256 ? v.palette[i] : 0;
        out.push((c >> 16) & 255, (c >> 8) & 255, c & 255, 255);
      }
    }));
  });
  s4('VOX '); i32(v.version || 150);
  s4('MAIN'); i32(0); i32(kids.length);
  for (const x of kids) out.push(x);
  return new Uint8Array(out);
}

/**
 * One model as faces, centred on its own middle the way a box is, in metres:
 * every face with nothing beside it, as two triangles. `ci` is each vertex's
 * colour index, for the caller to resolve against its roles.
 */
export function meshVox(m, scale) {
  const s = scale === undefined ? VOX_SCALE : scale;
  const sx = m.size[0], sy = m.size[1], sz = m.size[2];
  const filled = new Map();
  for (let q = 0; q < m.xyzi.length; q += 4) filled.set(m.xyzi[q] + sx * (m.xyzi[q + 1] + sy * m.xyzi[q + 2]), m.xyzi[q + 3]);
  const has = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz && filled.has(x + sx * (y + sy * z));
  /* File axes: +x, -x, +y, -y, +z, -z; and the four corners of each face. */
  const FACES = [
    [1, 0, 0, [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]],
    [-1, 0, 0, [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
    [0, 1, 0, [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]]],
    [0, -1, 0, [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
    [0, 0, 1, [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]],
    [0, 0, -1, [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]],
  ];
  const pos = [], nor = [], ci = [], idx = [];
  /* File (x, y, z) to scene (x, z, -y), centred. */
  const px = (x) => (x - sx / 2) * s, py = (z) => (z - sz / 2) * s, pz = (y) => -(y - sy / 2) * s;
  filled.forEach((c, key) => {
    const x = key % sx, y = ((key / sx) | 0) % sy, z = (key / (sx * sy)) | 0;
    for (const [dx, dy, dz, cor] of FACES) {
      if (has(x + dx, y + dy, z + dz)) continue;
      const b0 = pos.length / 3;
      for (const [a, bb, cc] of cor) {
        pos.push(px(x + a), py(z + cc), pz(y + bb));
        nor.push(dx, dz, -dy);
        ci.push(c);
      }
      /* The corners run anticlockwise seen from outside, and the axis swap is
         a rotation, so the winding survives it and the faces point out. */
      idx.push(b0, b0 + 1, b0 + 2, b0, b0 + 2, b0 + 3);
    }
  });
  return { pos, nor, ci, idx, faces: idx.length / 6 };
}

/** Base64 to bytes, for a model carried inside a page as text. */
export function voxBytes(b64) {
  const t = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, ''), out = new Uint8Array((clean.length * 3) >> 2);
  let bits = 0, acc = 0, k = 0;
  for (let i = 0; i < clean.length; i++) {
    acc = (acc << 6) | t.indexOf(clean[i]); bits += 6;
    if (bits >= 8) { bits -= 8; out[k++] = (acc >> bits) & 255; }
  }
  return out.subarray(0, k);
}
