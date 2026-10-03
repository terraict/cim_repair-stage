// オフライン版（閲覧のみの 1 つの HTML）を書き出す
//   いま画面に出ている 3D（補修・橋梁・航空写真）と表のデータ・写真を、offline_view.html に詰める。
//   形は書き出す時点で作り終えたもの（three の座標）を入れるので、開くときに Python も IFC の読み込みも要らない。
//   three.js と OrbitControls はファイルの中へ（data: の import map）。ネットにつながなくても開ける。
//   保存の仕組みを持たないので編集はできない。

const THREE_VER = "0.160.0";
const CDN = `https://cdn.jsdelivr.net/npm/three@${THREE_VER}`;

const b64 = (buf) => new Promise((res) => {
  const fr = new FileReader();
  fr.onload = () => res(String(fr.result).split(",")[1]);
  fr.readAsDataURL(new Blob([buf]));
});
const dataURL = (blob) => new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.readAsDataURL(blob); });
async function fetchDataURL(url) {
  try { const r = await fetch(url); if (!r.ok) return null; return await dataURL(await r.blob()); } catch { return null; }
}

// 配列をつないで 1 つの ArrayBuffer に。{ t: "f"|"u", o: 位置, n: 個数 } を返す
class Packer {
  constructor() { this.parts = []; this.size = 0; }
  add(a, t) {
    const typed = t === "f" ? new Float32Array(a) : new Uint32Array(a);
    const o = this.size;
    this.parts.push(typed);
    this.size += typed.byteLength;
    return { t, o, n: typed.length };
  }
  buffer() {
    const out = new Uint8Array(this.size);
    let o = 0;
    for (const p of this.parts) { out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), o); o += p.byteLength; }
    return out.buffer;
  }
}

export async function buildOffline({ viewer, doc, project, photos, photoBase, memoIdx, status }) {
  const pk = new Packer();
  const geos = [], geoId = new Map();
  const addGeo = (g, withUV) => {
    if (geoId.has(g)) return geoId.get(g);
    const e = { pos: pk.add(g.attributes.position.array, "f") };
    if (g.index) e.idx = pk.add(g.index.array, "u");
    if (withUV && g.attributes.uv) e.uv = pk.add(g.attributes.uv.array, "f");
    geos.push(e); geoId.set(g, geos.length - 1);
    return geos.length - 1;
  };

  status("オフライン版：形をまとめています…");
  const repairs = viewer.meshes.map((rec) => ({ g: addGeo(rec.mesh.geometry), m: rec.mesh.matrix.toArray(), rows: rec.rows, member: rec.member, head: rec.head }));
  const bridge = [];
  for (const grp of viewer.backgrounds) {
    for (const o of grp.children) {
      const c = o.material.color, e = { g: addGeo(o.geometry), c: [c.r, c.g, c.b], opaque: !!o.material.userData.opaque };
      // three の色は線形。書き出し側で sRGB に戻して渡す（読み込み側が SRGBColorSpace で入れるため）
      const s = new o.material.color.constructor().copy(c).convertLinearToSRGB();
      e.c = [s.r, s.g, s.b];
      if (o.isInstancedMesh) e.inst = pk.add(o.instanceMatrix.array.slice(0, o.count * 16), "f");
      bridge.push(e);
    }
  }
  const tiles = [];
  const photoTiles = viewer.tileGroups && viewer.tileGroups.photo;
  if (photoTiles) {
    status("オフライン版：航空写真を入れています…");
    for (const m of photoTiles.children) {
      const img = m.material.map && m.material.map.image;
      if (!img) continue;
      const url = await fetchDataURL(img.currentSrc || img.src);
      if (url) tiles.push({ g: addGeo(m.geometry, true), img: url });
    }
  }

  status("オフライン版：写真を入れています…");
  const ph = {};
  for (const [row, list] of Object.entries((photos && photos.rows) || {})) {
    for (const p of list) {
      const url = await fetchDataURL(photoBase(p));
      if (url) (ph[row] = ph[row] || []).push({ img: url, n: p.n, d: p.d });
    }
  }

  // 表のデータ。メモは見る人に意味のある欄だけ（作業用の欄は入れない）
  const keep = memoIdx;
  const odoc = {
    stepHeads: doc.stepHeads,
    memoHeads: keep.map((i) => doc.memoHeads[i]),
    types: doc.types,
    rows: doc.rows.map((r) => ({ row: r.row, name: r.name, type: r.type, stage: r.stage, rgb: r.rgb, transp: r.transp, steps: r.steps, memos: keep.map((i) => r.memos[i] || "") })),
  };
  const now = new Date(), p2 = (n) => String(n).padStart(2, "0");
  const meta = { id: project ? project.id : "local", name: project ? project.name : "施工段階", asof: `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`,
    doc: odoc, geos, repairs, bridge, tiles, photos: ph };

  status("オフライン版：ファイルを組み立てています…");
  const [tpl, three, orbit] = await Promise.all([
    fetch("./offline_view.html", { cache: "no-store" }).then((r) => r.text()),
    fetch(`${CDN}/build/three.module.js`).then((r) => r.text()),
    fetch(`${CDN}/examples/jsm/controls/OrbitControls.js`).then((r) => r.text()),
  ]);
  const jsURL = async (txt) => "data:text/javascript;base64," + await b64(new TextEncoder().encode(txt));
  const importmap = JSON.stringify({ imports: { "three": await jsURL(three), "three/addons/controls/OrbitControls.js": await jsURL(orbit) } });
  const bin = await b64(pk.buffer());
  // </script> が中身に混ざらないように（JSON の / を逃がす）
  const metaTxt = JSON.stringify(meta).replace(/</g, "\\u003c");
  const html = tpl.replace("%%TITLE%%", meta.name).replace("%%IMPORTMAP%%", () => importmap)
    .replace("%%META%%", () => metaTxt).replace("%%BIN%%", () => bin);
  return { html, name: `${meta.name}_オフライン版_${meta.asof}.html`, size: html.length };
}
