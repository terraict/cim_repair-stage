// 施工段階アプリ
//   正のファイル = sheet_to_ifc.read_tsv の形の TSV（フォルダの中の *.tsv）
//   IFC を組むのは tools/sheet_to_ifc.py（Pyodide で動かす。中身を作り直さない）
//   保存 = TSV（前の版は _履歴 へ）・IFC・CSV をフォルダへ書く
//   Web 版（projects.json があるとき）は見るだけで開き、パスワードで編集 → GitHub へコミット（web.js）
import { Viewer } from "./viewer.js?v=20261003173821";
import * as web from "./web.js?v=20261003173821";
import * as geo from "./geo.js?v=20261003173821";

const $ = (id) => document.getElementById(id);
const IFC_NAME = "repairmodel.ifc";
const HISTORY_DIR = "_履歴";

let py = null;          // Pyodide
let eng = null;         // engine モジュール
let doc = null;         // { stepHeads, memoHeads, types, rows, findings, ... }
let rowsByNo = new Map();
let dirHandle = null;   // フォルダ（File System Access API）
let fileHandle = null;  // TSV
let fileName = "";
let bgFiles = [];       // 橋梁モデルなど、下に敷く IFC（{ name, text() }）
let dirty = false;
let site = null;        // Web 版：projects.json の中身
let project = null;     // Web 版：開いている案件 { id, name, tsv, bridge:[...] }
let editable = true;    // Web 版は鍵を開けるまで false
let repo = null;        // Web 版：書き込める GitHub（web.Repo）
let baseSha = null;     // Web 版：編集を始めたときの TSV の sha（別の保存と取り違えないため）
const changedRows = new Set();
const selected = new Set();
let anchorRow = null;
const viewer = new Viewer($("view"), {
  onPick: (rowNos, additive) => pickRows(rowNos, additive),
});

// ------------------------------------------------------------ 起動

function status(text) { $("status").textContent = text; }

async function boot() {
  status("Python を読み込み中…（初回は 10 秒ほど）");
  py = await loadPyodide();
  for (const [name, urls] of [
    ["sheet_to_ifc.py", ["./sheet_to_ifc.py", "../tools/sheet_to_ifc.py"]],
    ["engine.py", ["./engine.py"]],
  ]) {
    const text = await fetchFirst(urls);
    py.FS.writeFile("/home/pyodide/" + name, text);
  }
  eng = py.pyimport("engine");
  site = await web.detectSite();
  if (site) await startSite();
  else status("フォルダを開いてください");
}

// ------------------------------------------------------------ Web 版

function siteRepo() {
  return site.repo || web.repoFromLocation();
}

async function startSite() {
  $("btnOpen").hidden = $("btnOpenFile").hidden = true;
  $("btnEdit").hidden = false;
  setEditable(false);
  const list = site.projects || [];
  const want = new URLSearchParams(location.search).get("p");
  let p = list.find((x) => x.id === want) || (list.length === 1 ? list[0] : null);
  if (!p && list.length) p = await choose(list.map((x) => ({ ...x, name: x.name })));
  if (!p) { status("案件がありません"); return; }
  project = p;
  if (want !== p.id) history.replaceState(null, "", "?p=" + encodeURIComponent(p.id));
  bgFiles = (p.bridge || []).map((path) => ({ name: path.split("/").pop(), text: () => web.fetchText(path) }));
  status("データを読み込み中…");
  await openText(await web.fetchText(p.tsv), p.name + ".tsv");
  $("docName").textContent = p.name;
  if (p.geo) {
    try { await setGeo(JSON.parse(await web.fetchText(p.geo))); }
    catch (e) { console.warn("geo", e); }
  }
}

function setEditable(on) {
  editable = on;
  const m = $("mode");
  if (site) {
    m.hidden = false;
    m.textContent = on ? "編集中" : "閲覧のみ";
    m.classList.toggle("edit", on);
    $("btnEdit").hidden = on;
    $("btnSave").hidden = !on;
  }
  if (doc) { buildTable(); syncSelection(); }
}

$("btnEdit").onclick = async () => {
  const auth = await web.loadAuth();
  if (!auth) { openSetup("まだ編集の設定がされていません。"); return; }
  $("loginMsg").textContent = "";
  $("pw").value = "";
  $("dlgLogin").showModal();
};
$("btnLoginCancel").onclick = () => $("dlgLogin").close();
$("lnkSetup").onclick = (e) => { e.preventDefault(); $("dlgLogin").close(); openSetup(""); };

$("fmLogin").onsubmit = async (e) => {
  e.preventDefault();
  const msg = $("loginMsg");
  msg.textContent = "確かめています…";
  try {
    const auth = await web.loadAuth();
    const token = await web.decryptToken(auth, $("pw").value);
    const r = new web.Repo(token, auth.owner, auth.repo, auth.branch);
    await r.check();
    await unlock(r);
    $("dlgLogin").close();
  } catch (err) {
    msg.textContent = err.message;
  }
};

function openSetup(note) {
  $("setupMsg").textContent = note;
  for (const id of ["stToken", "stPw1", "stPw2"]) $(id).value = "";
  $("dlgSetup").showModal();
}
$("btnSetupCancel").onclick = () => $("dlgSetup").close();

$("fmSetup").onsubmit = async (e) => {
  e.preventDefault();
  const msg = $("setupMsg");
  const pw = $("stPw1").value;
  if (pw !== $("stPw2").value) { msg.textContent = "パスワードが一致しません"; return; }
  if (pw.length < 12) { msg.textContent = "パスワードは 12 文字以上にしてください"; return; }
  const where = siteRepo();
  if (!where) { msg.textContent = "リポジトリが分かりません（projects.json の repo）"; return; }
  const tok = $("stToken").value.trim();
  // コピーが途中で切れていると GitHub は 401 Bad credentials としか言わないので、先に形を見る
  if (!/^github_pat_\w{60,}$/.test(tok) && !/^ghp_\w{30,}$/.test(tok)) {
    msg.textContent = `トークンの形ではありません（${tok.length} 文字。github_pat_ で始まる 90 文字ほどの文字列を、作った直後の画面からまるごとコピーしてください）`;
    return;
  }
  msg.textContent = "トークンを確かめています…";
  try {
    const r = new web.Repo(tok, where.owner, where.repo, where.branch || "main");
    await r.check();
    const auth = await web.encryptToken(r.token, pw, { owner: where.owner, repo: where.repo, branch: r.branch });
    msg.textContent = "書き込んでいます…";
    await r.commit([{ path: "auth.json", content: JSON.stringify(auth, null, 1) + "\n" }], "編集のパスワードを設定");
    $("dlgSetup").close();
    await unlock(r);
    status("編集の設定をしました。次からはパスワードだけで編集できます（公開ページへの反映は 1 分ほど後）");
  } catch (err) {
    msg.textContent = err.status === 401 ? "GitHub がこのトークンを受け付けません（期限切れ・取り消し・コピー違い）。作り直してまるごとコピーしてください"
      : err.status === 403 || err.status === 404 ? "このトークンではこのリポジトリを読み書きできません（Repository access で ict_repair-stage を選び、Contents を Read and write に）"
      : err.message;
  }
};

// 鍵が開いた。編集はいちばん新しい版から始める（Pages は反映が遅れる）
async function unlock(r) {
  repo = r;
  const latest = await repo.read(project.tsv);
  baseSha = latest.sha;
  if (!dirty && latest.text !== eng.tsv()) {
    reload(latest.text);
    status("GitHub のいちばん新しい版を読み込みました");
  }
  setEditable(true);
}

// 背景（橋梁）はそのままで、データだけ読み直す
function reload(text) {
  doc = JSON.parse(eng.load(text, fileName));
  rowsByNo = new Map(doc.rows.map((r) => [r.row, r]));
  buildFilters();
  buildTable();
  showFindings();
  viewer.recolor(doc.rows);
  updateLegend();
}

async function saveWeb() {
  if (!repo) { alert("編集するにはパスワードを入れてください"); return; }
  if (!dirty) { status("変更がないので保存していません"); return; }
  const errs = doc.findings.filter((x) => x.code.startsWith("E"));
  if (errs.length && !confirm(`検査でエラーが ${errs.length} 件あります（その行は IFC に出ません）。それでも保存しますか。`)) return;
  status("保存しています…");
  try {
    const now = await repo.sha(project.tsv);
    if (now !== baseSha) {
      alert("あなたが開いたあとに、別のところで保存されています。上書きしないよう止めました。\nページを開き直してから入れ直してください。");
      status("保存を止めました（別の保存があった）");
      return;
    }
    const dir = project.tsv.replace(/[^/]+$/, "");
    const ifc = uploadIfc();
    const res = await repo.commit([
      { path: project.tsv, content: eng.tsv() },
      { path: dir + IFC_NAME, content: ifc.ifc },
      { path: dir + project.id + ".csv", content: eng.csv() },
    ], `${project.name}: 施工段階を更新（${changedRows.size} 行）`);
    baseSha = res.shas[project.tsv];
    changedRows.clear();
    setDirty(false);
    status(`保存しました（${res.commit.slice(0, 7)}・物体 ${ifc.written} 個）。見る人のページには 1 分ほどで出ます。TerraCloud へは「IFC」で落として上げてください`);
  } catch (err) {
    alert("保存できませんでした。\n" + err.message);
    status("保存できませんでした");
  }
}

async function fetchFirst(urls) {
  for (const u of urls) {
    const r = await fetch(u, { cache: "no-cache" });
    if (r.ok) return await r.text();
  }
  throw new Error("見つからない: " + urls.join(" / "));
}

// ------------------------------------------------------------ 開く

$("btnOpen").onclick = async () => {
  if (!window.showDirectoryPicker) {
    alert("このブラウザはフォルダを開けません。Chrome か Edge を使うか、「ファイルを開く」を使ってください（保存はダウンロードになります）。");
    return;
  }
  if (!(await confirmDiscard())) return;
  let dir;
  try { dir = await window.showDirectoryPicker({ mode: "readwrite" }); }
  catch { return; }
  const tsvs = [], ifcs = [];
  for await (const [name, h] of dir.entries()) {
    if (h.kind === "file" && /\.tsv$/i.test(name)) tsvs.push(h);
    // 補修モデルの書き出し先以外の IFC は、下に敷く橋梁モデルとして読む
    if (h.kind === "file" && /\.ifc$/i.test(name) && name !== IFC_NAME) ifcs.push(h);
  }
  if (tsvs.length === 0) { alert("このフォルダに .tsv がありません。"); return; }
  let h = tsvs[0];
  if (tsvs.length > 1) {
    h = await choose(tsvs);
    if (!h) return;
  }
  dirHandle = dir;
  fileHandle = h;
  bgFiles = ifcs.map((x) => ({ name: x.name, text: async () => (await x.getFile()).text() }));
  await openText(await (await h.getFile()).text(), h.name);
};

$("btnOpenFile").onclick = async () => {
  if (!(await confirmDiscard())) return;
  $("fileInput").click();
};
$("fileInput").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  dirHandle = null; fileHandle = null; bgFiles = [];
  await openText(await f.text(), f.name);
};

function choose(handles) {
  return new Promise((resolve) => {
    const dlg = $("dlgPick"), list = $("pickList");
    list.innerHTML = "";
    for (const h of handles) {
      const b = document.createElement("button");
      b.textContent = h.name;   // ファイル（ローカル）でも案件（Web）でも name を出す
      b.onclick = () => { dlg.close(); resolve(h); };
      list.appendChild(b);
    }
    dlg.onclose = () => resolve(null);
    dlg.showModal();
  });
}

async function confirmDiscard() {
  return !dirty || confirm("保存していない変更があります。捨てて開きますか。");
}

async function openText(text, name) {
  status("読み込み中…");
  try {
    doc = JSON.parse(eng.load(text, name));
  } catch (e) {
    alert("読めませんでした。\n" + e.message.split("\n").slice(-2).join("\n"));
    status("読めませんでした");
    return;
  }
  fileName = name;
  rowsByNo = new Map(doc.rows.map((r) => [r.row, r]));
  selected.clear();
  setDirty(false);
  $("docName").textContent = (dirHandle ? dirHandle.name + " / " : "") + name;
  for (const id of ["btnSave", "btnCsv", "btnIfc"]) $(id).disabled = false;
  $("btnSave").textContent = dirHandle || site ? "保存" : "保存（ダウンロード）";
  $("empty").hidden = true;
  buildFilters();
  buildTable();
  showFindings();
  viewer.reset();
  await rebuildModel(false);
  await loadBackgrounds();
  viewer.fit();
}

async function loadBackgrounds() {
  $("bgCtl").hidden = bgFiles.length === 0;
  if (!bgFiles.length) status($("status").textContent + "　橋梁モデル：フォルダに IFC がありません");
  for (const b of bgFiles) {
    status(`橋梁モデルを読み込み中…（${b.name}）`);
    const t0 = performance.now();
    try {
      const n = await viewer.loadBackground(await b.text(), b.name);
      status(`${b.name}：${n} 個（${Math.round(performance.now() - t0)} ms）。表の行をダブルクリックでその場所へ。3D はクリックで選択、Ctrl で追加`);
    } catch (e) {
      status(`${b.name} を読めませんでした: ${e.message}`);
    }
  }
}
$("bgOpacity").oninput = () => viewer.setBgOpacity(Number($("bgOpacity").value));

// ------------------------------------------------------------ 表

function stepEnabled(r, i) {
  const t = doc.types[r.type];
  const label = t ? t.names[i + 1] : "";
  return (label || "").length > 1;     // 1文字（－）の段階は使わない（sheet_to_ifc と同じ）
}

function stepLabel(r, i) {
  const t = doc.types[r.type];
  return t ? t.names[i + 1] : "";
}

function toIso(s) {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s || "");
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
}
function fromIso(s) { return s ? s.replaceAll("-", "/") : ""; }
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function rgbCss(rgb) { return rgb ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` : "#888"; }

function buildFilters() {
  const ft = $("fType"), fs = $("fStage");
  ft.length = 1; fs.length = 1;
  const types = [...new Set(doc.rows.map((r) => r.type))];
  for (const t of types) ft.add(new Option(t || "（空）", t));
  const stages = [...new Set(doc.rows.map((r) => r.stage))];
  for (const s of stages) fs.add(new Option(s || "（空）", s));
  const bs = $("bStep");
  bs.length = 0;
  doc.stepHeads.forEach((h, i) => bs.add(new Option(h, String(i))));
  const bm = $("bMemo");
  bm.length = 0;
  shownMemos().forEach((i) => bm.add(new Option(doc.memoHeads[i], String(i))));
  $("bDate").value = today();
}

function buildTable() {
  const head = $("thead");
  head.innerHTML = "";
  for (const h of ["", "行", "部位の名称", "タイプ", "段階", ...doc.stepHeads, ...shownMemos().map((i) => doc.memoHeads[i])]) {
    const th = document.createElement("th");
    th.textContent = h;
    head.appendChild(th);
  }
  const body = $("tbody");
  body.innerHTML = "";
  for (const r of doc.rows) body.appendChild(rowTr(r));
  applyFilter();
}

function rowTr(r) {
  const tr = document.createElement("tr");
  tr.dataset.row = r.row;
  if (selected.has(r.row)) tr.classList.add("sel");
  const td = (cls, text) => {
    const c = document.createElement("td");
    if (cls) c.className = cls;
    if (text !== undefined) c.textContent = text;
    tr.appendChild(c);
    return c;
  };
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = selected.has(r.row);
  cb.onclick = (e) => { e.stopPropagation(); toggleRow(r.row, e.shiftKey, true); };
  td("").appendChild(cb);
  td("num", r.row);
  td("name", r.name).title = r.name;
  td("", r.type);
  const st = td("stage" + (r.transp >= 1 ? " hidden" : ""));
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.style.background = rgbCss(r.rgb);
  chip.style.opacity = r.transp >= 1 ? 0.25 : 1 - r.transp * 0.6;
  st.append(chip, r.stage + (r.transp >= 1 ? "（出ない）" : ""));
  r.steps.forEach((v, i) => {
    const c = td(r.hole && v === "" && i < lastFilled(r) ? "hole" : "");
    const iso = toIso(v);
    const inp = document.createElement("input");
    if (v !== "" && !iso) {
      inp.type = "text"; inp.value = v; inp.readOnly = true;
      inp.title = "日付の形でない値（エクセルから来たまま）。消してから入れ直す";
    } else {
      inp.type = "date"; inp.value = iso || "";
      inp.disabled = !editable || !stepEnabled(r, i);
      inp.title = stepLabel(r, i) || "";
      inp.onchange = () => applyChanges([[r.row, i, fromIso(inp.value)]]);
    }
    inp.onclick = (e) => e.stopPropagation();
    c.appendChild(inp);
  });
  for (const i of shownMemos()) td("", r.memos[i] || "");
  tr.onclick = (e) => toggleRow(r.row, e.shiftKey, e.ctrlKey || e.metaKey);
  tr.ondblclick = () => viewer.focusRows([r.row]);
  return tr;
}

// 見る人に意味の無いメモ（道具で置いたときの作業用の記録）は画面に出さない。案件ごとに projects.json の hideMemos
// データ・IFC・CSV には残る
function shownMemos() {
  const hide = new Set((project && project.hideMemos) || []);
  return doc.memoHeads.map((h, i) => i).filter((i) => !hide.has(doc.memoHeads[i]));
}

function lastFilled(r) {
  let n = -1;
  r.steps.forEach((v, i) => { if (v !== "") n = i; });
  return n;
}

function refreshRow(r) {
  const old = $("tbody").querySelector(`tr[data-row="${r.row}"]`);
  if (old) {
    const tr = rowTr(r);
    tr.hidden = old.hidden;
    old.replaceWith(tr);
  }
}

function visibleRows() {
  return [...$("tbody").children].filter((tr) => !tr.hidden).map((tr) => Number(tr.dataset.row));
}

function applyFilter() {
  const q = $("q").value.trim().toLowerCase();
  const ft = $("fType").value, fs = $("fStage").value;
  for (const tr of $("tbody").children) {
    const r = rowsByNo.get(Number(tr.dataset.row));
    const text = (r.name + " " + r.memos.join(" ") + " " + r.group).toLowerCase();
    tr.hidden = (q && !text.includes(q)) || (ft && r.type !== ft) || (fs && r.stage !== fs);
  }
}
$("q").oninput = applyFilter;
$("fType").onchange = applyFilter;
$("fStage").onchange = applyFilter;

// ------------------------------------------------------------ 選ぶ

function toggleRow(rowNo, range, additive) {
  if (range && anchorRow !== null) {
    const vis = visibleRows();
    const a = vis.indexOf(anchorRow), b = vis.indexOf(rowNo);
    if (a >= 0 && b >= 0) {
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(vis[i]);
    }
  } else if (additive) {
    selected.has(rowNo) ? selected.delete(rowNo) : selected.add(rowNo);
    anchorRow = rowNo;
  } else {
    const only = selected.size === 1 && selected.has(rowNo);
    selected.clear();
    if (!only) selected.add(rowNo);
    anchorRow = rowNo;
  }
  syncSelection();
}

function pickRows(rowNos, additive) {
  pickedNote(rowNos);
  if (!additive) selected.clear();
  for (const n of rowNos) additive && selected.has(n) ? selected.delete(n) : selected.add(n);
  if (rowNos.length) anchorRow = rowNos[0];
  syncSelection();
  const tr = rowNos.length && $("tbody").querySelector(`tr[data-row="${rowNos[0]}"]`);
  if (tr) { tr.hidden = false; tr.scrollIntoView({ block: "center" }); }
}

function syncSelection() {
  for (const tr of $("tbody").children) {
    const on = selected.has(Number(tr.dataset.row));
    tr.classList.toggle("sel", on);
    tr.firstChild.firstChild.checked = on;
  }
  $("bulk").hidden = selected.size === 0 || !editable;
  $("selCount").textContent = `${selected.size} 行を選択`;
  viewer.setSelected([...selected]);
  showDetail();
}

// ------------------------------------------------------------ 1 行のカード（段階・日付・メモ。編集中はメモを直せる）

function showDetail() {
  const box = $("detail");
  if (selected.size !== 1 || !doc) { box.hidden = true; return; }
  const r = rowsByNo.get([...selected][0]);
  if (!r) { box.hidden = true; return; }
  box.innerHTML = "";
  const x = document.createElement("button");
  x.className = "x"; x.textContent = "×"; x.title = "閉じる（選択を外す）";
  x.onclick = () => { selected.clear(); syncSelection(); };
  const h = document.createElement("h4");
  h.textContent = `${r.row} 行　${r.name}`;
  const dl = document.createElement("dl");
  const item = (k, v) => {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd");
    if (v instanceof Node) dd.appendChild(v); else dd.textContent = v;
    dl.append(dt, dd);
    return dd;
  };
  item("タイプ", r.type);
  const chip = document.createElement("span");
  chip.className = "chip"; chip.style.cssText = `display:inline-block;width:10px;height:10px;margin-right:4px;background:${rgbCss(r.rgb)}`;
  const st = document.createElement("span"); st.append(chip, r.stage + (r.transp >= 1 ? "（出ない）" : ""));
  item("段階", st);
  r.steps.forEach((v, i) => { if (stepEnabled(r, i)) item(`${doc.stepHeads[i]} ${stepLabel(r, i)}`, v || "－"); });
  const memoTitle = document.createElement("div");
  memoTitle.className = "sec"; memoTitle.textContent = "メモ";
  const ml = document.createElement("dl");
  shownMemos().forEach((i) => {
    const mh = doc.memoHeads[i];
    const dt = document.createElement("dt"); dt.textContent = mh;
    const dd = document.createElement("dd");
    if (editable) {
      const inp = document.createElement("input");
      inp.value = r.memos[i] || "";
      inp.onchange = () => applyMemo([[r.row, i, inp.value]]);
      dd.appendChild(inp);
    } else dd.textContent = r.memos[i] || "－";
    ml.append(dt, dd);
  });
  box.append(x, h, dl);
  // 表を隠したスマホでも段階を進められるように
  if (editable && r.step < r.steps.length && stepEnabled(r, r.step)) {
    const nx = document.createElement("button");
    nx.className = "addMemo primary";
    nx.textContent = `次の段階へ（${stepLabel(r, r.step)}・今日）`;
    nx.onclick = () => { applyChanges([[r.row, r.step, fromIso(today())]]); showDetail(); };
    box.appendChild(nx);
  }
  box.append(memoTitle, ml);
  if (editable && doc.memoHeads.length < 10) {
    const add = document.createElement("button");
    add.className = "addMemo"; add.textContent = "メモの欄を足す";
    add.title = "全部の行に新しいメモの欄を作る（エクセルの P〜Y の空いた見出しに名前を書くのと同じ。10 欄まで）";
    add.onclick = () => {
      const t = prompt("新しいメモの欄の名前（例：担当業者・材料搬入）");
      if (!t) return;
      const res = JSON.parse(eng.add_memo_col(t));
      if (!res.ok) { alert("足せませんでした（同じ名前があるか、10 欄に達しています）"); return; }
      doc.memoHeads = res.memoHeads;
      for (const nr of res.rows) { rowsByNo.set(nr.row, nr); doc.rows[doc.rows.findIndex((y) => y.row === nr.row)] = nr; }
      setDirty(true);
      buildFilters(); buildTable(); syncSelection();
      status(`メモの欄「${t}」を足しました（保存すると残ります）`);
    };
    box.appendChild(add);
  }
  box.hidden = false;
}

function applyMemo(changes) {
  if (!changes.length || !editable) return;
  const res = JSON.parse(eng.set_memos(JSON.stringify(changes)));
  for (const r of res.rows) {
    changedRows.add(r.row);
    rowsByNo.set(r.row, r);
    doc.rows[doc.rows.findIndex((x) => x.row === r.row)] = r;
    refreshRow(r);
  }
  setDirty(true);
  status(`${res.rows.length} 行のメモを変えました（保存すると TSV・IFC の属性に入ります）`);
}

$("btnMemo").onclick = () => {
  const i = Number($("bMemo").value);
  if (Number.isNaN(i)) return;
  applyMemo([...selected].map((n) => [n, i, $("bMemoVal").value]));
  showDetail();
};

$("btnUnsel").onclick = () => { selected.clear(); syncSelection(); };

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); if (doc && editable) save(); }
  if ((e.ctrlKey || e.metaKey) && e.key === "a" && doc && document.activeElement.tagName !== "INPUT") {
    e.preventDefault();
    for (const n of visibleRows()) selected.add(n);
    syncSelection();
  }
  if (e.key === "Escape" && selected.size) { selected.clear(); syncSelection(); }
});

// ------------------------------------------------------------ 日付を入れる

$("btnNext").onclick = () => {
  const date = fromIso($("bDate").value || today());
  const changes = [], skipped = [];
  for (const n of selected) {
    const r = rowsByNo.get(n);
    const i = r.step;                      // 次の空いた STEP（E 列と同じ数え方）
    if (i < r.steps.length && stepEnabled(r, i)) changes.push([n, i, date]);
    else skipped.push(n);
  }
  applyChanges(changes);
  if (skipped.length) status(`${skipped.length} 行はもう最後の段階なので入れていません（行 ${skipped.slice(0, 8).join(", ")}${skipped.length > 8 ? " …" : ""}）`);
};
$("btnSet").onclick = () => {
  const i = Number($("bStep").value), date = fromIso($("bDate").value);
  if (!date) { alert("日付を入れてください"); return; }
  applyChanges([...selected].filter((n) => stepEnabled(rowsByNo.get(n), i)).map((n) => [n, i, date]));
};
$("btnClear").onclick = () => {
  const i = Number($("bStep").value);
  applyChanges([...selected].map((n) => [n, i, ""]));
};

function applyChanges(changes) {
  if (!changes.length || !editable) return;
  for (const c of changes) changedRows.add(c[0]);
  const res = JSON.parse(eng.set_steps(JSON.stringify(changes)));
  for (const r of res.rows) {
    rowsByNo.set(r.row, r);
    const i = doc.rows.findIndex((x) => x.row === r.row);
    doc.rows[i] = r;
    refreshRow(r);
  }
  doc.findings = res.findings;
  showFindings();
  if (res.rejected.length) alert("入れなかったもの:\n" + res.rejected.map((x) => `行 ${x[0]}: ${x[3]}`).join("\n"));
  setDirty(true);
  viewer.recolor(doc.rows);
  updateLegend();
  status(`${res.rows.length} 行を変えました（保存すると TSV・IFC に入ります）`);
}

function setDirty(on) {
  dirty = on;
  $("dirty").hidden = !on;
  document.title = (on ? "● " : "") + "施工段階" + (fileName ? " - " + fileName : "");
}
window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

// ------------------------------------------------------------ 検査

function showFindings() {
  const f = doc.findings;
  const errs = f.filter((x) => x.code.startsWith("E")).length;
  const b = $("btnFindings");
  b.hidden = f.length === 0;
  b.textContent = errs ? `エラー ${errs}・注意 ${f.length - errs}` : `注意 ${f.length}`;
  b.style.color = errs ? "var(--err)" : "var(--warn)";
}
$("btnFindings").onclick = () => {
  const list = $("findList");
  list.innerHTML = "";
  for (const x of doc.findings) {
    const d = document.createElement("div");
    d.className = x.code[0];
    d.textContent = `行 ${x.row}  ${x.code}  ${x.msg}`;
    d.style.cursor = "pointer";
    d.onclick = () => { $("dlgFindings").close(); pickRows([x.row], false); viewer.focusRows([x.row]); };
    list.appendChild(d);
  }
  $("dlgFindings").showModal();
};

// ------------------------------------------------------------ 3D

async function rebuildModel(fit) {
  status("3D を作っています…");
  const t0 = performance.now();
  const res = JSON.parse(eng.ifc(true, "view.ifc"));
  await viewer.load(res.ifc, res.index, doc.rows);
  if (fit) viewer.fit();
  updateLegend();
  status(`物体 ${res.written} 個（${Math.round(performance.now() - t0)} ms）。表の行をダブルクリックでその場所へ。3D はクリックで選択、Ctrl で追加`);
}

function updateLegend() {
  const count = new Map();
  for (const r of doc.rows) {
    const k = r.type + "\t" + r.stage;
    const c = count.get(k) || { n: 0, rgb: r.rgb, hidden: r.transp >= 1 };
    c.n++;
    count.set(k, c);
  }
  const box = $("legend");
  box.innerHTML = "";
  for (const [k, c] of [...count.entries()].sort()) {
    const [t, s] = k.split("\t");
    const d = document.createElement("div");
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.style.background = rgbCss(c.rgb);
    chip.style.opacity = c.hidden ? 0.25 : 1;
    d.append(chip, `${t}：${s}${c.hidden ? "（出ない）" : ""}  ${c.n}`);
    box.appendChild(d);
  }
}

$("ghost").onchange = () => viewer.setGhost($("ghost").checked);
$("btnFit").onclick = () => viewer.fit();

// ------------------------------------------------------------ 保存・書き出し

function stem() { return fileName.replace(/\.[^.]+$/, ""); }
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function writeFile(dir, name, text) {
  const h = await dir.getFileHandle(name, { create: true });
  const w = await h.createWritable();
  await w.write(text);
  await w.close();
}

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function uploadIfc() {
  const res = JSON.parse(eng.ifc(false, IFC_NAME));
  return res;
}

async function save() {
  if (site) return saveWeb();
  const errs = doc.findings.filter((x) => x.code.startsWith("E"));
  if (errs.length && !confirm(`検査でエラーが ${errs.length} 件あります（その行は IFC に出ません）。それでも保存しますか。`)) return;
  const tsv = eng.tsv(), csv = eng.csv(), ifc = uploadIfc();
  if (!dirHandle) {
    download(fileName, tsv, "text/tab-separated-values");
    download(IFC_NAME, ifc.ifc, "application/octet-stream");
    setDirty(false);
    status(`ダウンロードしました（${fileName} と ${IFC_NAME}）`);
    return;
  }
  try {
    if ((await dirHandle.requestPermission({ mode: "readwrite" })) !== "granted") throw new Error("書き込みが許可されていません");
    // 前の版を _履歴 へ残してから上書きする
    const before = await (await fileHandle.getFile()).text();
    const hist = await dirHandle.getDirectoryHandle(HISTORY_DIR, { create: true });
    await writeFile(hist, `${stem()}_${stamp()}.tsv`, before);
    await writeFile(dirHandle, fileName, tsv);
    await writeFile(dirHandle, IFC_NAME, ifc.ifc);
    await writeFile(dirHandle, stem() + ".csv", csv);
  } catch (e) {
    alert("保存できませんでした。\n" + e.message);
    return;
  }
  setDirty(false);
  status(`保存しました：${fileName}・${IFC_NAME}（物体 ${ifc.written} 個）・${stem()}.csv。TerraCloud へは ${IFC_NAME} をアップロードしてください`);
}
$("btnSave").onclick = save;
$("btnCsv").onclick = () => download(stem() + ".csv", eng.csv(), "text/csv");
$("btnIfc").onclick = () => download(IFC_NAME, uploadIfc().ifc, "application/octet-stream");

// ------------------------------------------------------------ 背景（航空写真）

const BG_KEY = "repairstage.bg";
let geoInfo = null;
let geoCenter = 0;

// geo.json があれば、モデルの x 範囲の中央から 500 m 四方の写真を敷く
async function setGeo(g) {
  geoInfo = g;
  // 中心はモデル（補修）の x 範囲の中央。three の x はモデルの x から原点を引いたもの
  const box = viewer.boxOf(viewer.meshes.map((m) => m.mesh));
  const xmid = box.isEmpty() ? 140 : (box.min.x + box.max.x) / 2 + (viewer.origin ? viewer.origin.x : 0);
  geoCenter = xmid;
  for (const k of Object.keys(geo.LAYERS)) $("bgMode").querySelector(`option[value="${k}"]`).disabled = false;
  let mode = "photo";
  try { mode = localStorage.getItem(BG_KEY) || "photo"; } catch { /* 既定 */ }
  applyBg(mode);
}

// 地図タイルは選ばれたときに初めて読む（種類ごとに 81 枚）
function applyBg(mode) {
  const isMap = mode in geo.LAYERS;
  if (isMap && !geoInfo) mode = "grad";
  if (isMap && geoInfo) viewer.setTiles(mode, geo.tilesAround(geoInfo, geoCenter, 500, 18, mode), geoInfo.ground - geoInfo.z0);
  $("bgMode").value = mode;
  viewer.setBackgroundMode(mode);
  $("attrib").hidden = !(mode in geo.LAYERS);
  if (mode in geo.LAYERS) $("attribName").textContent = geo.LAYERS[mode].name;
}
for (const k of Object.keys(geo.LAYERS)) $("bgMode").querySelector(`option[value="${k}"]`).disabled = true;
$("bgMode").onchange = () => {
  // ★選んだ値を覚える（位置情報を読む前は地図が出せず暗い色に落ちるが、それを覚えると次も暗い色になる）
  const want = $("bgMode").value;
  applyBg(want);
  try { localStorage.setItem(BG_KEY, want); } catch { /* 覚えられなくても動く */ }
};

// ------------------------------------------------------------ 表を出す・隠す（スマホで 3D を広く使う）

const TABLE_KEY = "repairstage.notable";
function setTable(show) {
  document.body.classList.toggle("noTable", !show);
  $("btnTable").classList.toggle("on", show);
  $("btnTable").textContent = show ? "表" : "表を出す";
  try { localStorage.setItem(TABLE_KEY, show ? "0" : "1"); } catch { /* 同上 */ }
}
$("btnTable").onclick = () => setTable(document.body.classList.contains("noTable"));
try { setTable(localStorage.getItem(TABLE_KEY) !== "1"); } catch { setTable(true); }

// 3D で選んだとき、表が隠れていれば何を選んだかを下に出す
function pickedNote(rowNos) {
  if (!document.body.classList.contains("noTable") || !rowNos.length) return;
  const r = rowsByNo.get(rowNos[0]);
  if (r) status(`${r.row} 行：${r.name}（${r.type}・${r.stage}）${r.steps.filter(Boolean).length ? "　" + r.steps.filter(Boolean).join(" → ") : ""}`);
}

// ------------------------------------------------------------ 左右の幅（つまみをドラッグ。覚えておく）

const LEFTW_KEY = "repairstage.leftw";
function setLeftWidth(px) {
  const main = document.querySelector("main");
  if (px == null) { main.style.removeProperty("--leftw"); return; }
  const w = Math.max(240, Math.min(px, main.clientWidth - 240));
  main.style.setProperty("--leftw", w + "px");
}
try { const v = Number(localStorage.getItem(LEFTW_KEY)); if (v > 0) setLeftWidth(v); } catch { /* 覚えられなくても動く */ }
$("split").addEventListener("pointerdown", (e) => {
  const sp = $("split"), main = document.querySelector("main");
  sp.setPointerCapture(e.pointerId);
  sp.classList.add("drag");
  document.body.classList.add("dragging");
  const left = main.getBoundingClientRect().left;
  const move = (ev) => setLeftWidth(ev.clientX - left);
  const up = () => {
    sp.removeEventListener("pointermove", move);
    sp.classList.remove("drag");
    document.body.classList.remove("dragging");
    try { localStorage.setItem(LEFTW_KEY, String($("left").getBoundingClientRect().width)); } catch { /* 同上 */ }
  };
  sp.addEventListener("pointermove", move);
  sp.addEventListener("pointerup", up, { once: true });
});
$("split").ondblclick = () => { setLeftWidth(null); try { localStorage.removeItem(LEFTW_KEY); } catch { /* 同上 */ } };

// 試験用（開発者ツールから。保存はダウンロードになる）
window.__viewer = viewer;
window.__eng = () => eng;
window.__openUrl = async (u, bgs = []) => {
  dirHandle = null; fileHandle = null;
  bgFiles = bgs.map((b) => ({ name: decodeURIComponent(b.split("/").pop()), text: () => fetchFirst([b]) }));
  await openText(await fetchFirst([u]), decodeURIComponent(u.split("/").pop()));
};

boot().catch((e) => { status("起動できませんでした: " + e.message); console.error(e); });
