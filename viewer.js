// 3D 表示。IFC は web-ifc で読み、日付を変えたら色だけ塗り直す（形は変わらないので読み直さない）
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as WebIFC from "web-ifc";

const GHOST = new THREE.MeshBasicMaterial({ color: 0x9aa4ae, transparent: true, opacity: 0.08, depthWrite: false });
const SEL = new THREE.MeshBasicMaterial({ color: 0xffd400, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false, side: THREE.DoubleSide });

export class Viewer {
  constructor(el, { onPick }) {
    this.el = el;
    this.onPick = onPick;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    el.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x20262d);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 20000);
    this.camera.position.set(30, 30, 30);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(1, 2, 1.5);
    this.scene.add(sun);
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.overlay = new THREE.Group();
    this.scene.add(this.overlay);
    this.meshes = [];                 // { mesh, rows: [行番号...], member: 行番号 }
    this.byRow = new Map();           // 行番号 -> [mesh...]
    this.ghost = true;
    this.origin = null;
    this.backgrounds = [];
    this.bgOpacity = 0.4;   // 橋梁 IFC の透過 0.6 と同じ濃さ
    this.selected = new Set();
    this.api = null;

    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    this.bindPick();
    const loop = () => { this.controls.update(); this.renderer.render(this.scene, this.camera); requestAnimationFrame(loop); };
    loop();
  }

  resize() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async init() {
    if (this.api) return;
    this.api = new WebIFC.IfcAPI();
    this.api.SetWasmPath("https://cdn.jsdelivr.net/npm/web-ifc@0.0.66/", true);
    await this.api.Init();
  }

  // index: [[GUID, [行番号...]], ...]  まとめた物体は行が複数（形の並びは行の並びと同じ）
  async load(ifcText, index, rows) {
    await this.init();
    for (const m of this.meshes) { m.mesh.geometry.dispose(); m.mesh.material.dispose?.(); }
    this.group.clear();
    this.meshes = [];
    this.byRow = new Map();
    const byGuid = new Map(index.map(([g, r]) => [g, r]));
    const data = new TextEncoder().encode(ifcText);
    const id = this.api.OpenModel(data, { COORDINATE_TO_ORIGIN: false, CIRCLE_SEGMENTS: 24 });
    this.api.StreamAllMeshes(id, (flat) => {
      let guid = null;
      try { guid = this.api.GetLine(id, flat.expressID).GlobalId.value; } catch { /* 物体でない */ }
      const rowsOf = byGuid.get(guid) || [];
      const n = flat.geometries.size();
      for (let i = 0; i < n; i++) {
        const pg = flat.geometries.get(i);
        const geo = this.geometry(id, pg.geometryExpressID);
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.8 }));
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(this.placed(pg.flatTransformation));
        // 形の並び = まとめた行の並び。数が合わなければ先頭の行で塗る
        const member = rowsOf.length === n ? rowsOf[i] : rowsOf[0];
        const rec = { mesh, rows: rowsOf, member, head: rowsOf[0] };
        mesh.userData.rec = rec;
        this.group.add(mesh);
        this.meshes.push(rec);
        for (const r of rowsOf) {
          if (!this.byRow.has(r)) this.byRow.set(r, []);
          this.byRow.get(r).push(mesh);
        }
      }
    });
    this.api.CloseModel(id);
    this.recolor(rows);
  }

  // web-ifc の形を three の形に（座標は IFC のまま。置き方は placed で）
  geometry(id, gid) {
    const g = this.api.GetGeometry(id, gid);
    const v = this.api.GetVertexArray(g.GetVertexData(), g.GetVertexDataSize());
    const ix = this.api.GetIndexArray(g.GetIndexData(), g.GetIndexDataSize());
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(v.length / 2), nor = new Float32Array(v.length / 2);
    for (let k = 0, j = 0; k < v.length; k += 6, j += 3) {
      pos[j] = v[k]; pos[j + 1] = v[k + 1]; pos[j + 2] = v[k + 2];
      nor[j] = v[k + 3]; nor[j + 1] = v[k + 4]; nor[j + 2] = v[k + 5];
    }
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(ix), 1));
    g.delete();
    return geo;
  }

  // 置き方の行列。★補修モデルと橋梁モデルで同じ原点を引く（モデルごとに原点へ寄せると互いにずれる）。
  //   原点は最初に読んだ物体の位置。平面直角座標のような遠い座標でも float32 で崩れないように
  placed(flat) {
    const m = new THREE.Matrix4().fromArray(flat);
    if (!this.origin) this.origin = new THREE.Vector3().setFromMatrixPosition(m);
    m.elements[12] -= this.origin.x; m.elements[13] -= this.origin.y; m.elements[14] -= this.origin.z;
    return m;
  }

  // 橋梁モデルなど、日付で変わらないもの。色ごとに 1 つへまとめ、同じ形が多いもの（ボルト）は InstancedMesh
  async loadBackground(ifcText, label) {
    await this.init();
    const data = new TextEncoder().encode(ifcText);
    const id = this.api.OpenModel(data, { COORDINATE_TO_ORIGIN: false, CIRCLE_SEGMENTS: 12 });
    const inst = new Map();            // 形の番号 -> [{ matrix, color }]
    const geos = new Map();            // 形の番号 -> three の形（★流している間にしか取れない）
    this.api.StreamAllMeshes(id, (flat) => {
      const n = flat.geometries.size();
      for (let i = 0; i < n; i++) {
        const pg = flat.geometries.get(i);
        const c = pg.color;
        if (!geos.has(pg.geometryExpressID)) geos.set(pg.geometryExpressID, this.geometry(id, pg.geometryExpressID));
        if (!inst.has(pg.geometryExpressID)) inst.set(pg.geometryExpressID, []);
        inst.get(pg.geometryExpressID).push({ m: this.placed(pg.flatTransformation), c: [c.x, c.y, c.z] });
      }
    });
    const grp = new THREE.Group();
    grp.name = label;
    const merge = new Map();           // 色 -> { pos:[], nor:[], idx:[], n }
    const mats = [];
    let count = 0;
    for (const [gid, list] of inst) {
      const geo = geos.get(gid);
      count += list.length;
      if (list.length >= 8) {
        const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...list[0].c, THREE.SRGBColorSpace), roughness: 0.7 });
        mats.push(mat);
        const im = new THREE.InstancedMesh(geo, mat, list.length);
        list.forEach((x, k) => im.setMatrixAt(k, x.m));
        im.computeBoundingSphere();
        grp.add(im);
        continue;
      }
      const pos = geo.attributes.position.array, nor = geo.attributes.normal.array, ix = geo.index.array;
      for (const x of list) {
        const key = x.c.map((v) => v.toFixed(3)).join(",");
        if (!merge.has(key)) merge.set(key, { c: x.c, pos: [], nor: [], idx: [], n: 0 });
        const b = merge.get(key);
        const nm = new THREE.Matrix3().getNormalMatrix(x.m);
        const v = new THREE.Vector3();
        for (let k = 0; k < pos.length; k += 3) {
          v.set(pos[k], pos[k + 1], pos[k + 2]).applyMatrix4(x.m); b.pos.push(v.x, v.y, v.z);
          v.set(nor[k], nor[k + 1], nor[k + 2]).applyMatrix3(nm).normalize(); b.nor.push(v.x, v.y, v.z);
        }
        for (let k = 0; k < ix.length; k++) b.idx.push(ix[k] + b.n);
        b.n += pos.length / 3;
      }
      geo.dispose();
    }
    this.api.CloseModel(id);
    for (const b of merge.values()) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
      geo.setAttribute("normal", new THREE.Float32BufferAttribute(b.nor, 3));
      geo.setIndex(b.idx);
      const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...b.c, THREE.SRGBColorSpace), roughness: 0.85, side: THREE.DoubleSide });
      mats.push(mat);
      grp.add(new THREE.Mesh(geo, mat));
    }
    grp.userData.mats = mats;
    this.scene.add(grp);
    this.backgrounds.push(grp);
    this.setBgOpacity(this.bgOpacity);
    return count;
  }

  // 別の案件を開くとき。原点も決め直す
  reset() {
    this.clearBackgrounds();
    this.origin = null;
  }

  clearBackgrounds() {
    for (const g of this.backgrounds) {
      g.traverse((o) => o.geometry?.dispose());
      for (const m of g.userData.mats) m.dispose();
      this.scene.remove(g);
    }
    this.backgrounds = [];
  }

  // 補修が部材の面に乗っているので、橋梁は既定で半透明（重なって見えなくならないように）
  setBgOpacity(a) {
    this.bgOpacity = a;
    for (const g of this.backgrounds) {
      g.visible = a > 0;
      for (const m of g.userData.mats) {
        m.transparent = a < 1; m.opacity = a; m.depthWrite = a >= 1;
        m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1;
        m.needsUpdate = true;
      }
    }
  }

  recolor(rows) {
    const by = new Map(rows.map((r) => [r.row, r]));
    for (const rec of this.meshes) {
      const head = by.get(rec.head), me = by.get(rec.member) || head;
      if (!head) continue;
      const hidden = head.transp >= 1;            // 物体が出るかは先頭の行で決まる（sheet_to_ifc と同じ）
      rec.hidden = hidden;
      if (hidden) {
        rec.mesh.material = GHOST;
        rec.mesh.visible = this.ghost;
      } else {
        let mat = rec.mesh.material;
        if (mat === GHOST) mat = rec.mesh.material = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.8 });
        const rgb = me.rgb || [128, 128, 128];
        mat.color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
        mat.transparent = me.transp > 0;
        mat.opacity = 1 - me.transp;
        mat.depthWrite = !(me.transp > 0);
        rec.mesh.visible = true;
      }
    }
    this.paintSelection();
  }

  setGhost(on) {
    this.ghost = on;
    for (const rec of this.meshes) if (rec.hidden) rec.mesh.visible = on;
  }

  setSelected(rowNos) {
    this.selected = new Set(rowNos);
    this.paintSelection();
  }

  // 選んだ物は手前の物に隠れても見えるよう、黄色の写しを最前面に重ねる
  paintSelection() {
    for (const m of this.overlay.children) m.material.dispose();
    this.overlay.clear();
    for (const rec of this.meshes) {
      if (!rec.rows.some((r) => this.selected.has(r))) continue;
      const m = new THREE.Mesh(rec.mesh.geometry, SEL.clone());
      m.matrixAutoUpdate = false;
      m.matrix.copy(rec.mesh.matrix);
      m.renderOrder = 10;
      this.overlay.add(m);
    }
  }

  boxOf(meshes) {
    const box = new THREE.Box3();
    for (const m of meshes) {
      m.geometry.computeBoundingBox();
      box.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrix));
    }
    return box;
  }

  frame(box, side = false) {
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const r = Math.max(size.length() / 2, 2);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    // 全体は長い向きの横から斜めに見下ろす（橋は細長いので斜め 45° だと線になる）
    if (side) dir.set(size.x >= size.z ? 0 : 1, 0.7, size.x >= size.z ? 1 : 0).normalize();
    if (!isFinite(dir.x) || dir.lengthSq() === 0) dir.set(1, 1, 1).normalize();
    this.controls.target.copy(c);
    this.camera.position.copy(c).addScaledVector(dir, r * 2.8);
    this.camera.near = r / 200; this.camera.far = r * 200;
    this.camera.updateProjectionMatrix();
  }

  fit() {
    const box = this.boxOf(this.meshes.map((m) => m.mesh));
    for (const g of this.backgrounds) if (g.visible) box.union(new THREE.Box3().setFromObject(g));
    this.frame(box, true);
  }

  focusRows(rowNos) {
    const ms = rowNos.flatMap((r) => this.byRow.get(r) || []);
    if (ms.length) this.frame(this.boxOf(ms));
  }

  bindPick() {
    const ray = new THREE.Raycaster(), p = new THREE.Vector2();
    let down = null;
    const dom = this.renderer.domElement;
    dom.addEventListener("pointerdown", (e) => { down = [e.clientX, e.clientY]; });
    dom.addEventListener("pointerup", (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;   // 回しただけ
      const rect = dom.getBoundingClientRect();
      p.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(p, this.camera);
      const targets = this.meshes.filter((m) => m.mesh.visible).map((m) => m.mesh);
      const hits = ray.intersectObjects(targets, false);
      // 色の付いた物体を薄い物体より先に拾う
      const hit = hits.find((h) => !h.object.userData.rec.hidden) || hits[0];
      this.onPick(hit ? hit.object.userData.rec.rows : [], e.ctrlKey || e.metaKey || e.shiftKey);
    });
  }
}
