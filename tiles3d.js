// 背景の 3D（Google の Photorealistic 3D Tiles）をモデルの座標に重ねる（2026-10-06。fork だけの機能）
//   地球の座標（ECEF）→ モデル (x, y, z) → three の座標（viewer.modelToThree と同じ）。
//   モデルの原点（A1 の端 × 中心線 × 起点の路面）の楕円体高 ＝ geo.z0（標高）＋ geo.geoid（ジオイド高）
//   モデルの橋と重なる既存の橋は、geo.clip の箱（モデル座標 [x0, x1, y0, y1, z0, z1]）の中を消す
//   キーは projects.json の googleMapsKey（使えるサイトを制限したキー）か、URL の ?gkey=
//   ★Google のキーが無ければ Cesium ion 経由（projects.json の cesiumIonToken か ?ion=。資産 2275207 ＝ Google Photorealistic 3D Tiles）。
//     ion の無料プラン（Community）は「商用の検討のための試用」まで。本番で使い続けるなら有料プランか Google のキーへ（2026-10-06）
//   ★請求を出さない：Google が数えるのは読み始め（root tileset）1 回ごと（月 1,000 回まで無料）。
//     ページを開いたときに 3D を自動で選ばない（app.js）・3 時間たっても自動で読み直さない（autoRefreshToken: false）。
//     上限は Google Cloud の割り当て（1 日の回数）で止める
import * as THREE from "three";
import { TilesRenderer, FAILED } from "3d-tiles-renderer";
import { GoogleCloudAuthPlugin, CesiumIonAuthPlugin } from "3d-tiles-renderer/plugins";
import * as G from "./geo.js";

const A = 6378137.0, F = 1 / 298.257222101, E2 = F * (2 - F);

function ecef(latDeg, lonDeg, h) {
  const la = latDeg * Math.PI / 180, lo = lonDeg * Math.PI / 180;
  const N = A / Math.sqrt(1 - E2 * Math.sin(la) ** 2);
  return [(N + h) * Math.cos(la) * Math.cos(lo), (N + h) * Math.cos(la) * Math.sin(lo), (N * (1 - E2) + h) * Math.sin(la)];
}

// ECEF → three の 4×4（three の Matrix4。行列は倍精度のまま作る）
export function ecefToThree(geo, origin) {
  const [e0, n0] = G.modelToEN(geo, 0, 0);
  const [lat, lon] = G.toLatLon(e0, n0, geo.zone);
  const O = ecef(lat, lon, (geo.z0 || 0) + (geo.geoid || 0));
  const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
  const E = [-Math.sin(lo), Math.cos(lo), 0];
  const Nn = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
  const U = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  // ★geo.dir は平面直角の北・東。子午線収差（平面直角の北と真北のずれ）を足す
  const [e1, n1] = G.toEN(lat + 0.001, lon, geo.zone);
  const gam = Math.atan2(e1 - e0, n1 - n0);            // 真北が平面直角でどちらへ傾くか
  const [ux0, uy0] = geo.dir;                           // [東, 北]
  const c = Math.cos(gam), s = Math.sin(gam);
  const ux = ux0 * c - uy0 * s, uy = ux0 * s + uy0 * c; // 真北・真東の成分へ回す
  const X = [0, 1, 2].map((i) => ux * E[i] + uy * Nn[i]);
  const Y = [0, 1, 2].map((i) => -uy * E[i] + ux * Nn[i]);
  const Z = U;
  // model = Rᵀ (P − O)、three = (mx − ox, mz − oy, −my − oz)
  const o = origin || { x: 0, y: 0, z: 0 };
  const rows = [X, Z, Y.map((v) => -v)];
  const t = [o.x, o.y, o.z];
  const m = new THREE.Matrix4();
  const el = [];
  for (let r = 0; r < 3; r++) {
    const R = rows[r];
    el.push([R[0], R[1], R[2], -(R[0] * O[0] + R[1] * O[1] + R[2] * O[2]) - t[r]]);
  }
  m.set(...el[0], ...el[1], ...el[2], 0, 0, 0, 1);
  return m;
}

// モデル座標の箱 → three の平面 6 枚（箱の中が負 ＝ clipIntersection で中だけ消える）
export function clipPlanes(viewer, box) {
  const [x0, x1, y0, y1, z0, z1] = box;
  const a = viewer.modelToThree(x0, y1, z0), b = viewer.modelToThree(x1, y0, z1);
  const P = (n, p) => new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...n), p);
  return [P([1, 0, 0], b), P([-1, 0, 0], a), P([0, 1, 0], b), P([0, -1, 0], a), P([0, 0, 1], b), P([0, 0, -1], a)];
}

export class GoogleTiles {
  // auth ＝ { google: キー } か { ion: トークン }
  constructor(viewer, geo, auth, onAttrib, onError) {
    this.viewer = viewer;
    this.onAttrib = onAttrib;
    this.onError = onError;
    const tiles = this.tiles = new TilesRenderer();
    if (auth.google) tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: auth.google, autoRefreshToken: false }));
    else tiles.registerPlugin(new CesiumIonAuthPlugin({ apiToken: auth.ion, assetId: "2275207", autoRefreshToken: false }));
    this.via = auth.google ? "" : "Cesium ion 経由";
    tiles.group.matrixAutoUpdate = false;
    tiles.group.matrix.copy(ecefToThree(geo, viewer.origin));
    tiles.group.matrixWorldNeedsUpdate = true;
    tiles.group.renderOrder = -2;
    tiles.setCamera(viewer.camera);
    tiles.setResolutionFromRenderer(viewer.camera, viewer.renderer);
    this.box = geo.clip || null;
    this.planes = this.box ? clipPlanes(viewer, this.box) : [];
    viewer.renderer.localClippingEnabled = true;
    tiles.addEventListener("load-model", ({ scene }) => {
      scene.traverse((o) => {
        if (!o.material) return;
        for (const m of [].concat(o.material)) { m.clippingPlanes = this.planes; m.clipIntersection = true; m.needsUpdate = true; }
      });
    });
    this.errors = 0;
    tiles.addEventListener("load-error", () => { this.errors++; });
    viewer.scene.add(tiles.group);
    this.visible = true;
    this._last = "";
    const loop = () => {
      if (this.disposed) return;
      if (this.tiles.group.visible && !this.failed) {
        this.viewer.camera.updateMatrixWorld();
        this.tiles.setResolutionFromRenderer(this.viewer.camera, this.viewer.renderer);
        this.tiles.update();
        const at = [this.via, ...this.tiles.getAttributions().map((a) => a.type === "string" ? a.value : "")].filter(Boolean).join(" ");
        if (at !== this._last) { this._last = at; this.onAttrib?.(at); }
      }
      requestAnimationFrame(loop);
    };
    loop();
    // キー・トークンが違う・上限に達した など（ライブラリは自動では読み直さない）。描画が止まる裏のタブでも分かるようにタイマーで見る
    this._watch = setInterval(() => {
      if (this.tiles.rootLoadingState === FAILED && !this.failed) {
        this.failed = true;
        clearInterval(this._watch);
        this.onError?.();
      }
    }, 1000);
  }

  setVisible(v) { this.tiles.group.visible = v; }

  // 既存の橋を消すかどうか（材料は同じ配列を見ているので、中身を入れ替えるだけでよい）
  setClip(on) {
    this.planes.length = 0;
    if (on && this.box) this.planes.push(...clipPlanes(this.viewer, this.box));
  }

  dispose() {
    this.disposed = true;
    clearInterval(this._watch);
    this.viewer.scene.remove(this.tiles.group);
    this.tiles.dispose();
  }
}
