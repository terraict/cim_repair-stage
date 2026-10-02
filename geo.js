// 背景の航空写真（国土地理院 シームレス空中写真）をモデルの下に敷く
//   モデル（IFC）は橋だけの座標のまま。写真のほうをモデルの座標へ写す。
//   geo.json … { zone, A1:[東, 北], dir:[東, 北]（A1→A2 の単位ベクトル）, z0（モデル z=0 の標高）, ground（写真を置く標高） }
//   モデル (x, y) → 平面直角 (東, 北) ＝ A1 ＋ x・dir ＋ y・(−dir北, dir東)。標高 ＝ z ＋ z0
//   換算式は tools/jprect.py と同じ（国土地理院の式）

const A = 6378137.0, F = 298.257222101, M0 = 0.9999, n = 1 / (2 * F - 1);
const ORIGIN = { 1: [33, 129.5], 2: [33, 131], 3: [36, 132 + 10 / 60], 4: [33, 133.5], 5: [36, 134 + 20 / 60],
  6: [36, 136], 7: [36, 137 + 10 / 60], 8: [36, 138.5], 9: [36, 139 + 50 / 60], 10: [40, 140 + 50 / 60],
  11: [44, 140.25], 12: [44, 142.25], 13: [44, 144.25], 14: [26, 142], 15: [26, 127.5], 16: [26, 124],
  17: [26, 131], 18: [20, 136], 19: [26, 154] };
const AC = [1 + n ** 2 / 4 + n ** 4 / 64, -1.5 * (n - n ** 3 / 8 - n ** 5 / 64), 15 / 16 * (n ** 2 - n ** 4 / 4),
  -35 / 48 * (n ** 3 - 5 / 16 * n ** 5), 315 / 512 * n ** 4, -693 / 1280 * n ** 5];
const AL = [0, n / 2 - 2 * n ** 2 / 3 + 5 * n ** 3 / 16 + 41 * n ** 4 / 180 - 127 * n ** 5 / 288,
  13 * n ** 2 / 48 - 3 * n ** 3 / 5 + 557 * n ** 4 / 1440 + 281 * n ** 5 / 630,
  61 * n ** 3 / 240 - 103 * n ** 4 / 140 + 15061 * n ** 5 / 26880,
  49561 * n ** 4 / 161280 - 179 * n ** 5 / 168, 34729 * n ** 5 / 80640];
const ABAR = M0 * A / (1 + n) * AC[0];
const rad = (d) => d * Math.PI / 180;

// 緯度経度 → 平面直角 [東, 北]
export function toEN(lat, lon, zone) {
  const [la0, lo0] = ORIGIN[zone];
  const phi = rad(lat), lam = rad(lon), phi0 = rad(la0), lam0 = rad(lo0);
  const k = 2 * Math.sqrt(n) / (1 + n);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - k * Math.atanh(k * Math.sin(phi)));
  const tb = Math.sqrt(1 + t * t);
  const xi = Math.atan(t / Math.cos(lam - lam0)), eta = Math.atanh(Math.sin(lam - lam0) / tb);
  let x = xi, y = eta;
  for (let j = 1; j <= 5; j++) {
    x += AL[j] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    y += AL[j] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  let s = AC[0] * phi0;
  for (let j = 1; j <= 5; j++) s += AC[j] * Math.sin(2 * j * phi0);
  return [ABAR * y, ABAR * x - M0 * A / (1 + n) * s];
}

// 平面直角 → モデル (x, y)
export function enToModel(geo, e, nn) {
  const de = e - geo.A1[0], dn = nn - geo.A1[1];
  const [ux, uy] = geo.dir;
  return [de * ux + dn * uy, de * -uy + dn * ux];
}

// モデル (x, y) → 平面直角
export function modelToEN(geo, x, y) {
  const [ux, uy] = geo.dir;
  return [geo.A1[0] + x * ux - y * uy, geo.A1[1] + x * uy + y * ux];
}

// Web メルカトルのタイル番号 ⇔ 緯度経度
const tile2lon = (x, z) => x / 2 ** z * 360 - 180;
const tile2lat = (y, z) => { const m = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(Math.sinh(m)); };
const lon2tile = (lon, z) => (lon + 180) / 360 * 2 ** z;
const lat2tile = (lat, z) => (1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2 * 2 ** z;

// 平面直角 → 緯度経度（タイル範囲を決めるだけなので、ニュートン法で toEN を逆に解く）
export function toLatLon(e, nn, zone) {
  let lat = ORIGIN[zone][0], lon = ORIGIN[zone][1];
  for (let i = 0; i < 8; i++) {
    const [e0, n0] = toEN(lat, lon, zone);
    lat += (nn - n0) / 110950; lon += (e - e0) / (111320 * Math.cos(rad(lat)));
  }
  return [lat, lon];
}

// 敷くタイルの一覧。中心（モデルの x 範囲の中央）から half m 四方
export function tilesAround(geo, xmid, half, z) {
  const [ce, cn] = modelToEN(geo, xmid, 0);
  const [la0, lo0] = toLatLon(ce - half, cn - half, geo.zone);
  const [la1, lo1] = toLatLon(ce + half, cn + half, geo.zone);
  const x0 = Math.floor(lon2tile(lo0, z)), x1 = Math.floor(lon2tile(lo1, z));
  const y0 = Math.floor(lat2tile(la1, z)), y1 = Math.floor(lat2tile(la0, z));
  const out = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    // 四隅（左上・右上・右下・左下）をモデルの (x, y) へ
    const corners = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]].map(([tx, ty]) => {
      const [e, nn] = toEN(tile2lat(ty, z), tile2lon(tx, z), geo.zone);
      return enToModel(geo, e, nn);
    });
    out.push({ url: `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x}/${y}.jpg`, corners });
  }
  return out;
}
