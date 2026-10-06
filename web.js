// Web 版（GitHub Pages）のふるまい
//   見る人   … URL を開くだけ。データは Pages から読む（読むだけ）
//   編集する人 … パスワードで GitHub の書き込み用トークンを解き、保存は GitHub へ直接コミットする
//
// ★トークンは auth.json に暗号化して置く（PBKDF2-SHA256 で鍵を作り AES-GCM）。リポジトリは公開なので
//   暗号文は誰でも取れる。強さはパスワードの長さで決まる（12 文字以上にする）。
//   トークンは「このリポジトリの Contents の読み書き」だけの fine-grained にしておけば、漏れても被害はこのリポジトリまで

const API = "https://api.github.com";
const ITER = 600000;

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// ------------------------------------------------------------ サイト

// projects.json があれば Web 版。無ければ（手元の start.bat）null
export async function detectSite() {
  try {
    const r = await fetch("./projects.json?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// Pages の URL から持ち主とリポジトリを出す（https://<owner>.github.io/<repo>/）
export function repoFromLocation() {
  const host = location.hostname;
  if (!host.endsWith(".github.io")) return null;
  const owner = host.split(".")[0];
  const repo = location.pathname.split("/").filter(Boolean)[0];
  return repo ? { owner, repo } : null;
}

export async function fetchText(path) {
  // Pages の CDN は 10 分覚えるので、?t= で毎回取り直す
  const r = await fetch(path + (path.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error(`${path} が読めません（${r.status}）`);
  return await r.text();
}

export async function loadAuth() {
  try {
    const r = await fetch("./auth.json?t=" + Date.now(), { cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// ------------------------------------------------------------ 暗号

async function keyFrom(password, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encryptToken(token, password, repo) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(password, salt);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token));
  return { v: 1, kdf: "PBKDF2-SHA256", iter: ITER, salt: b64(salt), iv: b64(iv), data: b64(data),
           owner: repo.owner, repo: repo.repo, branch: repo.branch || "main" };
}

export async function decryptToken(auth, password) {
  const key = await keyFrom(password, unb64(auth.salt));
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(auth.iv) }, key, unb64(auth.data));
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error("パスワードが違います");
  }
}

// ------------------------------------------------------------ GitHub

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Repo {
  constructor(token, owner, repo, branch = "main") {
    Object.assign(this, { token, owner, repo, branch });
    // ★GitHub の API は、コミットした直後にブランチの先頭を読むと、少しのあいだ前の先頭を返すことがある（読み取りの遅れ）。
    //   保存・写真が続くと「別の保存があった」で止まったり、ref の更新が 422（not a fast forward）で断られたりした（2026-10-06）。
    //   このページで上書きしたことのある先頭（old）が返ってきたら、遅れとみなして待って読み直す
    this.old = new Set();
  }

  // ブランチの先頭のコミット（読み取りの遅れを待つ）
  async head() {
    for (let i = 0; ; i++) {
      const h = (await this.api("GET", `/git/ref/heads/${this.branch}`)).object.sha;
      if (!this.old.has(h) || i >= 8) return h;
      await sleep(800 * (i + 1));
    }
  }

  async api(method, path, body, accept) {
    const r = await fetch(`${API}/repos/${this.owner}/${this.repo}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, Accept: accept || "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    if (!r.ok) {
      let msg = "";
      try { msg = (await r.json()).message; } catch { /* 本文なし */ }
      const e = new Error(`GitHub ${method} ${path}: ${r.status} ${msg}`);
      e.status = r.status;
      throw e;
    }
    return accept && accept.endsWith(".raw") ? await r.text() : await r.json();
  }

  // 書き込めるトークンか（Contents の書き込み権）
  async check() {
    const info = await this.api("GET", "");
    if (info.permissions && info.permissions.push === false) throw new Error("このトークンでは書き込めません");
    this.branch = this.branch || info.default_branch;
    return info;
  }

  // いまのブランチにあるファイルの中身と blob の sha（先頭のコミットに固定して読む。中身と sha が食い違わない）
  async read(path) {
    const h = await this.head();
    const meta = await this.api("GET", `/contents/${encodeURI(path)}?ref=${h}`);
    const text = await this.api("GET", `/contents/${encodeURI(path)}?ref=${h}`, null, "application/vnd.github.raw");
    return { text, sha: meta.sha };
  }

  async sha(path) {
    const h = await this.head();
    try { return (await this.api("GET", `/contents/${encodeURI(path)}?ref=${h}`)).sha; }
    catch (e) { if (e.status === 404) return null; throw e; }
  }

  // files: [{ path, content }] を 1 つのコミットにまとめる。返り値は path -> blob sha
  async commit(files, message) {
    const shas = {};
    const items = [];
    for (const f of files) {
      if (f.delete) { items.push({ path: f.path, mode: "100644", type: "blob", sha: null }); continue; }   // 消す
      // 写真などは base64（encoding: "base64"）、文字は utf-8
      const blob = await this.api("POST", "/git/blobs", { content: f.content, encoding: f.encoding || "utf-8" });
      shas[f.path] = blob.sha;
      items.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    // 先頭が古く読めていると ref の更新が 422 で断られる。読み直してやり直す（ほかのファイルは先頭のまま残る）
    for (let i = 0; ; i++) {
      const head = await this.head();
      const base = await this.api("GET", `/git/commits/${head}`);
      const t = await this.api("POST", "/git/trees", { base_tree: base.tree.sha, tree: items });
      const c = await this.api("POST", "/git/commits", { message, tree: t.sha, parents: [head] });
      try {
        await this.api("PATCH", `/git/refs/heads/${this.branch}`, { sha: c.sha });
        this.old.add(head);
        return { commit: c.sha, shas };
      } catch (e) {
        if (e.status !== 422 || i >= 4) throw e;
        this.old.add(head);
        await sleep(1000 * (i + 1));
      }
    }
  }
}
