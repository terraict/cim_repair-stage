# -*- coding: utf-8 -*-
r"""入力シートから補修モデル(IFC2X3)を書き出す。

    sheet_to_ifc.exe <入力> [出力.ifc] [オプション]

<入力> は次のどちらでもよい。

  * `.tsv`  … マクロが書き出した中間ファイル（実運用はこちら。
              画面に見えているとおりが渡るので、保存していない編集も反映される）
  * `.xlsm` … 入力シートそのもの（Excel を開かずに確かめるとき。
              数式のキャッシュではなく色表から自分で引き直すので、
              保存直後でなくても結果は同じ）

出力を省くと、入力と同じフォルダの `repairmodel.ifc`。

オプション
  --check-only       書かずに検査だけする
  --force            エラーがあっても書く（既定は書かない）
  --include-hidden   透過1（＝非表示）の行も出す
  --quiet            要約だけ出す

終了コード 0=書けた / 1=エラーがあって書かなかった / 2=引数や読み込みの失敗

VBA からの呼び方は repairifc/vba/Module1.bas を見る（WScript.Shell の Run で終了を待つ）。
"""
import sys, os, io, math, hashlib, argparse, collections, datetime, warnings

warnings.simplefilter("ignore")   # openpyxl の注意書きが画面に出ないように

BS = chr(92)                       # 円記号。IFC の \X2\ を書くのに使う
ESC_IN, ESC_OUT = BS + "X2" + BS, BS + "X0" + BS
LABEL_COLOR, LABEL_TRANSP, LABEL_NAME = u"色", u"透過", u"名称"
DEFAULT_TYPE = u"*default"         # color_option の 2〜4 行目（デフォルト値）
NSTEP = 6                          # STEP0..STEP5（入力シートの色の表の列数。TSV ではいくつでもよい）


def out_stream():
    return io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", newline="\n")


# ============================================================ データ

class Row(object):
    u"""input シートの1行。"""

    def __init__(self, row, name, type_, steps, memos, model, m, coords, group=u""):
        self.row = row
        self.group = group        # 同じ名前の行は1つの物体にまとめる（空ならまとめない）
        self.name = name or u""
        self.type = type_ or u""
        self.steps = steps            # STEP1..5 のセルの値（文字列。空は u""）
        self.memos = memos            # メモ列の値
        self.model = model or u""     # ext_poly / 3p_face / sphere
        self.m = m                    # 点数（sphere は半径）
        self.coords = coords          # ["x,y,z", ...]

    @property
    def step(self):
        u"""いまのステップ番号。埋まっている STEP セルの数（Excel の E 列と同じ）。"""
        n = 0
        for v in self.steps:
            if v == u"":
                break
            n += 1
        return n

    @property
    def has_step_hole(self):
        u"""STEP セルが飛んでいる（Excel の MATCH も数えられない）。"""
        seen_empty = False
        for v in self.steps:
            if v == u"":
                seen_empty = True
            elif seen_empty:
                return True
        return False


class Palette(object):
    u"""color_option シート。1タイプ = 色/透過/名称 の3行 × STEP0..5。"""

    def __init__(self):
        self.colors = collections.OrderedDict()   # 色名 -> (r, g, b)
        self.types = collections.OrderedDict()    # タイプ名 -> {ラベル: [STEP0..5]}

    def cell(self, type_, label, step):
        u"""そのタイプ・そのラベル・そのステップの値。

        空なら *default* の同じステップを使う（Excel の ISBLANK 分岐と同じ。
        同じタイプの STEP0 へ戻るのではなく、デフォルト行の同じ列を見る）。
        """
        step = max(step, 0)

        def at(block):
            vals = (block or {}).get(label, [])
            return vals[step] if step < len(vals) else u""
        v = at(self.types.get(type_))
        if v != u"":
            return v
        return at(self.types.get(DEFAULT_TYPE))

    def width(self):
        u"""色の表の列数（STEP0 から）。いちばん長いタイプに合わせる。"""
        return max([NSTEP] + [len(v) for b in self.types.values() for v in b.values()])

    def rgb(self, color_name):
        return self.colors.get(color_name)


class Book(object):
    def __init__(self):
        self.source = u""
        self.unit = u"m"
        self.step_heads = []      # ["STEP1", ...]
        self.memo_heads = []      # ["部位1", "部位2", "路線"]
        self.group_head = u""     # まとめ列の見出し（無ければ空）
        self.palette = Palette()
        self.rows = []


def norm_rgb(rgb):
    u"""0〜255 を IFC の 0〜1 文字列へ。Excel の IFS と同じ丸め方。"""
    def one(v):
        if v == 255:
            return u"1.0"
        if v == 0:
            return u"0.0"
        t = u"%.15g" % (v / 255.0)   # Excel の有効15桁に合わせる
        return t if u"." in t else t + u".0"
    return u",".join(one(v) for v in rgb)


# ============================================================ 読む: .xlsm

def _txt(v):
    if v is None:
        return u""
    if isinstance(v, float) and v == int(v):
        return u"%d" % int(v)
    if isinstance(v, datetime.datetime):
        return v.strftime(u"%Y/%m/%d")
    if isinstance(v, datetime.date):
        return v.strftime(u"%Y/%m/%d")
    return u"%s" % v


def read_xlsm(path):
    import openpyxl
    book = Book()
    book.source = path
    wb = openpyxl.load_workbook(path, data_only=False)
    if u"input" not in wb.sheetnames or u"color_option" not in wb.sheetnames:
        raise SystemExit(u"input / color_option シートが無い: %s" % path)
    ws, co = wb[u"input"], wb[u"color_option"]

    # 列の位置は見出しから探す（列を足されても動くように）
    c_step = c_cal = c_coord = None
    for i in range(1, ws.max_column + 1):
        r1, r2 = ws.cell(1, i).value, ws.cell(2, i).value
        if r2 == u"STEP1":
            c_step = i
        elif r1 == u"calendar":
            c_cal = i
        elif r1 == u"coordinate":
            c_coord = i
            break
    if None in (c_step, c_cal, c_coord):
        raise SystemExit(u"見出し STEP1 / calendar / coordinate が見つからない: %s" % path)

    # まとめ列。見出しは1行目に書く（2行目に書くとメモ列として数えてしまう）
    c_group = None
    for i in range(c_cal + 1, c_coord):
        if _txt(ws.cell(1, i).value) in (u"まとめ", u"group"):
            c_group = i
            book.group_head = _txt(ws.cell(2, i).value) or _txt(ws.cell(1, i).value)
    book.unit = _txt(ws.cell(2, c_coord + 1).value) or u"m"
    book.step_heads = [_txt(ws.cell(2, c).value) for c in range(c_step, c_cal)]
    c = c_cal + 1
    while _txt(ws.cell(2, c).value) != u"":
        book.memo_heads.append(_txt(ws.cell(2, c).value))
        c += 1
    n_memo = len(book.memo_heads)

    # color_option: 色名→RGB
    for r in range(5, co.max_row + 1):
        name = _txt(co.cell(r, 12).value)
        if name == u"":
            continue
        try:
            book.palette.colors[name] = tuple(int(co.cell(r, k).value) for k in (13, 14, 15))
        except (TypeError, ValueError):
            pass

    # color_option: タイプ 3行ずつ。2〜4行目はデフォルト
    def read_block(top, key):
        block = {}
        for k in range(3):
            label = _txt(co.cell(top + k, 2).value)
            block[label] = [_txt(co.cell(top + k, 3 + s).value) for s in range(NSTEP)]
        book.palette.types[key] = block

    read_block(2, DEFAULT_TYPE)
    r = 5
    while r <= co.max_row:
        name = _txt(co.cell(r, 1).value)
        if name != u"":
            read_block(r, name)
        r += 3

    # input の行
    last = 2
    for r in range(3, ws.max_row + 1):
        if _txt(ws.cell(r, c_coord).value) != u"" or _txt(ws.cell(r, 1).value) != u"":
            last = r
    for r in range(3, last + 1):
        if _txt(ws.cell(r, 1).value) == u"" and _txt(ws.cell(r, 2).value) == u"":
            continue
        coords = []
        for c in range(c_coord + 2, ws.max_column + 1):
            v = _txt(ws.cell(r, c).value)
            coords.append(v if v != u"" else None)
        while coords and coords[-1] is None:
            coords.pop()
        book.rows.append(Row(
            r, _txt(ws.cell(r, 1).value), _txt(ws.cell(r, 2).value),
            [_txt(ws.cell(r, c).value) for c in range(c_step, c_cal)],
            [_txt(ws.cell(r, c_cal + 1 + k).value) for k in range(n_memo)],
            _txt(ws.cell(r, c_coord).value), _txt(ws.cell(r, c_coord + 1).value), coords,
            _txt(ws.cell(r, c_group).value) if c_group else u""))
    return book


# ============================================================ 読む: .tsv
#
# マクロが書く中間ファイル。UTF-8 / タブ区切り。
#   #ifcsheet <版>
#   #book     <ブックのフルパス>
#   #unit     m または mm
#   #stepcols STEP1 ... （タブ区切り）
#   #memocols 部位1 ... （タブ区切り）
#   [colors]  色名 R G B
#   [types]   タイプ名 ラベル STEP0..STEP5    ※デフォルトは *default
#   [rows]    行番号 名称 タイプ STEP値... メモ値... 形式 点数 座標...

def read_tsv(path):
    book = Book()
    book.source = path
    section = u""
    with io.open(path, encoding="utf-8-sig", newline=u"") as f:
        for raw in f:
            line = raw.rstrip(u"\r\n")
            if line == u"":
                continue
            if line.startswith(u"["):
                section = line.strip()
                continue
            f0 = line.split(u"\t")
            if line.startswith(u"#"):
                key = f0[0]
                if key == u"#book":
                    book.source = f0[1] if len(f0) > 1 else path
                elif key == u"#unit":
                    book.unit = (f0[1] if len(f0) > 1 else u"m") or u"m"
                elif key == u"#stepcols":
                    book.step_heads = f0[1:]
                elif key == u"#memocols":
                    book.memo_heads = f0[1:]
                elif key == u"#groupcol":
                    book.group_head = f0[1] if len(f0) > 1 else u"まとめ"
                continue
            if section == u"[colors]" and len(f0) >= 4:
                try:
                    book.palette.colors[f0[0]] = (int(f0[1]), int(f0[2]), int(f0[3]))
                except ValueError:
                    pass
            elif section == u"[types]" and len(f0) >= 2:
                vals = f0[2:]                  # STEP0 から。施工段階アプリで STEP を足すと 6 列より長くなる
                vals += [u""] * (NSTEP - len(vals))
                book.palette.types.setdefault(f0[0], {})[f0[1]] = vals
            elif section == u"[rows]":
                ns, nm = len(book.step_heads), len(book.memo_heads)
                ng = 1 if book.group_head else 0
                need = 1 + 2 + ns + nm + ng + 2
                if len(f0) < need:
                    f0 = f0 + [u""] * (need - len(f0))
                i = 0
                row = int(f0[i] or 0); i += 1
                name = f0[i]; i += 1
                type_ = f0[i]; i += 1
                steps = f0[i:i + ns]; i += ns
                memos = f0[i:i + nm]; i += nm
                group = u""
                if ng:
                    group = f0[i]; i += 1
                model = f0[i]; i += 1
                m = f0[i]; i += 1
                coords = [c if c != u"" else None for c in f0[i:]]
                while coords and coords[-1] is None:
                    coords.pop()
                book.rows.append(Row(row, name, type_, steps, memos, model, m, coords, group))
    if not book.step_heads:
        raise SystemExit(u"#stepcols が無い。中間ファイルの形式が違う: %s" % path)
    return book


# ============================================================ 書く: .tsv / .csv
#
# 施工段階アプリ（repairifc/app/）は read_tsv の形をそのまま正のファイルにする。
# xlsm から移すときは --to-tsv。書いたものは read_tsv で同じ Book に戻る。

def _cell(v):
    u"""TSV の1セル。タブと改行は区切りと見分けがつかないので空白にする。"""
    v = u"" if v is None else u"%s" % v
    return v.replace(u"\t", u" ").replace(u"\r\n", u" ").replace(u"\n", u" ").replace(u"\r", u" ")


def write_tsv(book, fp):
    u"""Book を read_tsv の形で fp（文字列を書けるもの）へ書く。"""
    def line(cells):
        fp.write(u"\t".join(_cell(c) for c in cells) + u"\n")

    line([u"#ifcsheet", u"1"])
    line([u"#book", book.source])
    line([u"#unit", book.unit])
    line([u"#stepcols"] + list(book.step_heads))
    line([u"#memocols"] + list(book.memo_heads))
    if book.group_head:
        line([u"#groupcol", book.group_head])
    fp.write(u"[colors]\n")
    for name, rgb in book.palette.colors.items():
        line([name] + [u"%d" % v for v in rgb])
    fp.write(u"[types]\n")
    width = max(book.palette.width(), len(book.step_heads) + 1)
    for name, block in book.palette.types.items():
        for label in (LABEL_COLOR, LABEL_TRANSP, LABEL_NAME):
            vals = list(block.get(label, []))
            line([name, label] + vals + [u""] * (width - len(vals)))
    fp.write(u"[rows]\n")
    for r in book.rows:
        cells = [u"%d" % r.row, r.name, r.type] + list(r.steps) + list(r.memos)
        if book.group_head:
            cells.append(r.group)
        cells += [r.model, r.m] + [c if c is not None else u"" for c in r.coords]
        line(cells)


def write_csv(book, fp):
    u"""人が Excel で見るための一覧。段階・段階名・色は色表から引いた値を添える。"""
    import csv
    w = csv.writer(fp, lineterminator=u"\r\n")
    width = max([len(r.coords) for r in book.rows] or [0])
    head = [u"行", u"部位の名称", u"タイプ", u"段階", u"段階名", u"色", u"透過"]
    head += list(book.step_heads) + list(book.memo_heads)
    if book.group_head:
        head.append(book.group_head)
    head += [u"形式", u"AE"] + [u"座標%d" % (i + 1) for i in range(width)]
    w.writerow(head)
    for r in book.rows:
        rv = Resolved(r, book.palette)
        cells = [r.row, r.name, r.type, rv.step, rv.stage, rv.color, rv.transp]
        cells += list(r.steps) + list(r.memos)
        if book.group_head:
            cells.append(r.group)
        cells += [r.model, r.m] + [c if c is not None else u"" for c in r.coords]
        w.writerow(cells)


# ============================================================ 解く

class Resolved(object):
    u"""1行を IFC にするのに要るものを、色表から引き直した結果。"""

    def __init__(self, row, palette):
        self.row = row
        s = row.step
        self.step = s
        self.color = palette.cell(row.type, LABEL_COLOR, s)
        self.stage = palette.cell(row.type, LABEL_NAME, s)
        t = palette.cell(row.type, LABEL_TRANSP, s)
        try:
            self.transp = float(t) if t != u"" else 0.0
        except ValueError:
            self.transp = 0.0
        self.rgb = palette.rgb(self.color)
        self.visible = self.transp < 1.0
        # 属性に出す工程名。色表の「名称」から引く（セルのコメントには頼らない）
        self.step_labels = [palette.cell(row.type, LABEL_NAME, i + 1)
                            for i in range(len(row.steps))]

    @property
    def storey(self):
        u"""Navisworks で画層のように見えるまとまり。タイプ-施工段階。"""
        return u"%s-%s" % (self.row.type, self.stage)


def points_of(row):
    u"""座標セルを (x, y, z) の並びに。読めないものは None を入れて返す。"""
    pts = []
    for v in row.coords:
        if v is None:
            pts.append(None)
            continue
        f = v.split(u",")
        if len(f) != 3:
            pts.append(False)
            continue
        try:
            pts.append(tuple(float(x) for x in f))
        except ValueError:
            pts.append(False)
    return pts


# ============================================================ 検査

def check(book):
    u"""(行, 記号, 文) の並びを返す。記号が E で始まるものはエラー。"""
    found = []
    for row in book.rows:
        rv = Resolved(row, book.palette)
        if row.type not in book.palette.types:
            found.append((row.row, u"E6", u"タイプ「%s」が color_option に無い" % row.type))
        if rv.color != u"" and rv.rgb is None:
            found.append((row.row, u"E7", u"色名「%s」が色表に無い" % rv.color))
        if row.has_step_hole:
            found.append((row.row, u"W4", u"STEP の日付が飛んでいる。手前までしか数えない"))
        if row.model == u"":
            found.append((row.row, u"W5", u"形式(AD列)が空。まだ形が無いので出さない"))
            continue
        if row.model not in SHAPES:
            found.append((row.row, u"E5", u"知らない形式「%s」" % row.model))
            continue

        hole = None
        want = needs_cells(row)
        if want is not None:
            for i, v in enumerate(row.coords):
                if v is None and any(x is not None for x in row.coords[i + 1:]):
                    hole = i
                    break
            if hole is not None:
                found.append((row.row, u"E4",
                              u"座標セルに穴がある（%d 個目のあたり。編集の残りかす）"
                              % (hole + 1)))
            n = len([v for v in row.coords if v is not None])
            if want > n:
                found.append((row.row, u"E2", u"%s は %s %s なら %d セル。%d セルしかない"
                              % (row.model, SHAPES[row.model].ae, row.m, want, n)))
            elif want < n:
                found.append((row.row, u"E2",
                              u"%s は %s %s なら %d セル。%d セルある。余りは使われない"
                              % (row.model, SHAPES[row.model].ae, row.m, want, n)))

        # いちばん確かな検査。捨てる紙に実際に組み立ててみる
        try:
            if build_shape(IfcFile(), row) is None:
                found.append((row.row, u"E8", u"形が作れない（%s の書き方を確かめる）"
                              % row.model))
        except Exception as e:
            found.append((row.row, u"E8", u"形が作れない: %s（%s は AE列=%s / AF以降=%s）"
                          % (e, row.model, SHAPES[row.model].ae, SHAPES[row.model].af)))
    return found


def is_error(code):
    return code.startswith(u"E")


# ============================================================ IFC の下ごしらえ

GUID_CHARS = u"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$"


def ifc_guid(key):
    u"""鍵から IFC の GUID(22文字)を作る。同じ鍵なら毎回同じ値。

    版を比べたときに「同じ補修箇所」を追えるように、乱数ではなく
    中身から決める。IfcOpenShell と同じ圧縮のしかた。
    """
    b = hashlib.md5(key.encode("utf-8")).digest()

    def enc(v, ln):
        return u"".join(GUID_CHARS[(v // (64 ** (ln - i - 1))) % 64] for i in range(ln))

    out = [enc(b[0], 2)]
    for i in range(1, 16, 3):
        out.append(enc((b[i] << 16) + (b[i + 1] << 8) + b[i + 2], 4))
    return u"".join(out)


def ifc_str(s):
    u"""IFC の文字列リテラル。非 ASCII は X2 エスケープ(UTF-16BE)で書く。

    空文字は '--'（元のマクロと同じ。属性の欄が消えず「未記入」と分かる）。
    """
    if s is None or s == u"":
        return u"'--'"
    out, buf = [], []

    def flush():
        if buf:
            out.append(ESC_IN + u"".join(u"%04X" % u16 for u16 in buf) + ESC_OUT)
            del buf[:]

    for ch in s:
        if ord(ch) < 128:
            flush()
            if ch in (u"'", BS):
                out.append(ch + ch)     # IFC はどちらも2つ重ねて書く
            else:
                out.append(ch)
        else:
            b = ch.encode("utf-16-be")  # 補助面は 2 個(サロゲートペア)になる
            for i in range(0, len(b), 2):
                buf.append((b[i] << 8) + b[i + 1])
    flush()
    return u"'" + u"".join(out) + u"'"


# ============================================================ IFC を書く

class IfcFile(object):
    u"""#番号を採ってから書く。前借り（まだ書いていない番号の参照）をしない。"""

    def __init__(self):
        self.lines = []
        self.n = 0
        self._cache = {}

    def add(self, text):
        u"""実体を1つ書いて #番号 を返す。"""
        self.n += 1
        ref = u"#%d" % self.n
        self.lines.append(u"%s = %s;" % (ref, text))
        return ref

    def once(self, key, make):
        u"""同じものを何度も作らない（色・原点・下位コンテキストなど）。"""
        if key not in self._cache:
            self._cache[key] = make()
        return self._cache[key]


def q(guid):
    return u"'" + guid + u"'"


def build_shape(f, row):
    u"""行の形を書いて (本体の #番号, 表現の種類) を返す。作れなければ None。

    形式(AD列)ごとに AE列とAF以降の意味が変わる。仕様は SHAPES を見る。
    python_fromlsp/ifc_exchange.py（3dhaikinx と共有の CSV→IFC）と
    同じ言い方に合わせてある。
    """
    spec = SHAPES.get(row.model)
    if spec is None:
        return None
    return spec.build(f, row)


# ---------------------------------------------------------- 小道具

def face(f, point_refs):
    loop = f.add(u"IFCPOLYLOOP((%s))" % u",".join(point_refs))
    bound = f.add(u"IFCFACEOUTERBOUND(%s,.T.)" % loop)
    return f.add(u"IFCFACE((%s))" % bound)


def num(v):
    u"""IFC の REAL。必ず小数点を付ける。"""
    t = u"%.15g" % v
    if u"." not in t and u"e" not in t and u"E" not in t:
        t += u"."
    return t


def xyz(p):
    return u",".join(num(v) for v in p)


# ★★★모델の基準点。**IFC は原点の近くに置かないと閲覧ソフトが困る。**
#   ある橋では X≒23,350 / Y≒−178,156（原点から 180 km）で、
#   ビューアが画面を合わせられなかった（2026-09-09 ユーザー
#   「遠くの座標が含まれていないでしょうか。閲覧ソフト上で画面が
#   うまく合わさりません」）。
#   ★**引くだけでは位置が消える。**引いた分は IfcSite の配置へ入れるので、
#     測地の位置は保たれる（`--base` を付けたときだけ働く）
BASE = (0.0, 0.0, 0.0)


def point(f, p):
    return f.add(u"IFCCARTESIANPOINT((%s))"
                 % xyz((p[0] - BASE[0], p[1] - BASE[1], p[2] - BASE[2])))


def triple(text):
    u"""'x,y,z' を数の3つ組に。読めなければ ValueError。"""
    parts = [t for t in text.replace(u";", u",").split(u",") if t.strip() != u""]
    if len(parts) != 3:
        raise ValueError(text)
    return tuple(float(t) for t in parts)


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def unit(v):
    n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) ** 0.5
    if n == 0:
        raise ValueError(u"長さ0の向き")
    return (v[0] / n, v[1] / n, v[2] / n)


def placement(f, at, direction, rotate_deg):
    u"""押し出しの土台。at に置き、direction を高さ方向にする。

    ifc_exchange.make_axis2placement3d と同じ決め方
    （向きと直交する軸を1つ選び、rotate で断面を回す）。
    """
    z = unit(direction)
    tmp = (1.0, 0.0, 0.0) if abs(z[0]) < 0.9 else (0.0, 1.0, 0.0)
    x = unit(cross(z, tmp))
    y = cross(z, x)
    a = math.radians(rotate_deg)
    ref = (math.sin(a) * x[0] + math.cos(a) * y[0],
           math.sin(a) * x[1] + math.cos(a) * y[1],
           math.sin(a) * x[2] + math.cos(a) * y[2])
    loc = point(f, at)
    zd = f.add(u"IFCDIRECTION((%s))" % xyz(z))
    xd = f.add(u"IFCDIRECTION((%s))" % xyz(ref))
    return f.add(u"IFCAXIS2PLACEMENT3D(%s,%s,%s)" % (loc, zd, xd))


def profile_origin(f):
    return f.once(u"prof2d", lambda: f.add(
        u"IFCAXIS2PLACEMENT2D(%s,$)" % f.add(u"IFCCARTESIANPOINT((0.,0.))")))


def extrude(f, profile, place, depth):
    up = f.once(u"dirz", lambda: f.add(u"IFCDIRECTION((0.,0.,1.))"))
    return f.add(u"IFCEXTRUDEDAREASOLID(%s,%s,%s,%s)" % (profile, place, up, num(depth)))


def arg(row, i, default=u""):
    u"""AF から数えて i 番目(0起点)のセル。無ければ default。"""
    if i < len(row.coords) and row.coords[i] is not None:
        return row.coords[i]
    return default


# ---------------------------------------------------------- 形ごと

class Shape(object):
    def __init__(self, key, ae, af, note, build, needs=None):
        self.key = key          # AD列に書く言葉
        self.ae = ae            # AE列の意味
        self.af = af            # AF以降の意味
        self.note = note
        self.build = build
        self.needs = needs      # 要る座標セル数を返す関数（None なら数えない）


def _need_by_points(per):
    def f(row):
        return per * int(float(row.m))
    return f


def build_ext_poly(f, row):
    m = int(float(row.m))
    pts = [triple(arg(row, i)) for i in range(2 * m)]
    top = [point(f, p) for p in pts[:m]]
    bottom = [point(f, p) for p in pts[m:]]
    faces = [face(f, top), face(f, list(reversed(bottom)))]
    for i in range(m):
        j = (i + 1) % m
        faces.append(face(f, [top[j], top[i], bottom[i], bottom[j]]))
    shell = f.add(u"IFCCLOSEDSHELL((%s))" % u",".join(faces))
    return f.add(u"IFCFACETEDBREP(%s)" % shell), u"Brep"


def build_3p_face(f, row):
    m = int(float(row.m))
    faces = []
    for i in range(m):
        faces.append(face(f, [point(f, triple(arg(row, i * 3 + k))) for k in range(3)]))
    shell = f.add(u"IFCCLOSEDSHELL((%s))" % u",".join(faces))
    return f.add(u"IFCSHELLBASEDSURFACEMODEL((%s))" % shell), u"SurfaceModel"


def build_poly_face(f, row):
    u"""1セル = 1面。点は ; で区切る。 x,y,z; x,y,z; x,y,z ..."""
    m = int(float(row.m))
    faces = []
    for i in range(m):
        cell = arg(row, i)
        pts = [triple(t) for t in cell.split(u";") if t.strip() != u""]
        if len(pts) < 3:
            raise ValueError(cell)
        faces.append(face(f, [point(f, p) for p in pts]))
    shell = f.add(u"IFCCLOSEDSHELL((%s))" % u",".join(faces))
    return f.add(u"IFCSHELLBASEDSURFACEMODEL((%s))" % shell), u"SurfaceModel"


def build_box(f, row):
    u"""直方体。AE=高さ AF=底面の中心 AG=dx,dy AH=向き(既定 0,0,1) AI=回転角(度)"""
    height = float(row.m)
    at = triple(arg(row, 0))
    dxy = arg(row, 1).split(u",")
    dx, dy = float(dxy[0]), float(dxy[1])
    direction = triple(arg(row, 2, u"0,0,1"))
    rot = float(arg(row, 3, u"0") or 0)
    prof = f.add(u"IFCRECTANGLEPROFILEDEF(.AREA.,$,%s,%s,%s)"
                 % (profile_origin(f), num(dx), num(dy)))
    return extrude(f, prof, placement(f, at, direction, rot), height), u"SweptSolid"


def build_cylinder(f, row):
    u"""円柱・円管。AE=高さ AF=底面の中心 AG=半径 AH=厚み(空で中実) AI=向き"""
    height = float(row.m)
    at = triple(arg(row, 0))
    radius = float(arg(row, 1))
    thick = arg(row, 2, u"").strip()
    direction = triple(arg(row, 3, u"0,0,1"))
    place = placement(f, at, direction, 0.0)
    outer = extrude(f, f.add(u"IFCCIRCLEPROFILEDEF(.AREA.,$,%s,%s)"
                             % (profile_origin(f), num(radius))), place, height)
    if thick == u"" or float(thick) <= 0 or float(thick) >= radius:
        return outer, u"SweptSolid"
    inner = extrude(f, f.add(u"IFCCIRCLEPROFILEDEF(.AREA.,$,%s,%s)"
                             % (profile_origin(f), num(radius - float(thick)))),
                    place, height)
    return f.add(u"IFCBOOLEANRESULT(.DIFFERENCE.,%s,%s)" % (outer, inner)), u"CSG"


def build_bar(f, row):
    u"""折れ線に沿った丸棒・丸管。AE=半径 AF以降=通る点。

    ひび割れ注入の線、アンカーボルト、鉄筋など。
    (ifc_exchange の REBAR にあたる。曲げは今は入れていない)
    """
    radius = float(row.m)
    pts = []
    for i in range(len(row.coords)):
        v = arg(row, i)
        if v == u"":
            break
        pts.append(triple(v))
    if len(pts) < 2:
        raise ValueError(u"点が2つ要る")
    line = f.add(u"IFCPOLYLINE((%s))" % u",".join(point(f, p) for p in pts))
    return f.add(u"IFCSWEPTDISKSOLID(%s,%s,$,$,$)" % (line, num(radius))), \
        u"AdvancedSweptSolid"


def build_sphere(f, row):
    u"""球。AE=半径 AF=中心。点の印に使う。"""
    radius = float(row.m)
    a = f.add(u"IFCAXIS2PLACEMENT3D(%s,$,$)" % point(f, triple(arg(row, 0))))
    return f.add(u"IFCSPHERE(%s,%s)" % (a, num(radius))), u"CSG"


SHAPES = collections.OrderedDict()
for _s in (
    Shape(u"ext_poly", u"点数 m", u"上面 m 点 + 下面 m 点(対の順)",
          u"押し出した立体。上面は外側から見て左回り", build_ext_poly,
          _need_by_points(2)),
    Shape(u"3p_face", u"面数 m", u"3点 x 面数",
          u"三角形の集まり。閉じていなくてよい", build_3p_face, _need_by_points(3)),
    Shape(u"poly_face", u"面数 m", u"1セル1面。点は ; 区切り",
          u"四角以上の面をそのまま。分割しなくてよい", build_poly_face,
          _need_by_points(1)),
    Shape(u"box", u"高さ", u"底面の中心 / dx,dy / 向き / 回転角(度)",
          u"直方体。削孔・箱抜き・当て板など", build_box),
    Shape(u"cylinder", u"高さ", u"底面の中心 / 半径 / 厚み / 向き",
          u"円柱と円管。厚みを書くと管になる", build_cylinder),
    Shape(u"bar", u"半径", u"通る点をいくつでも",
          u"折れ線に沿った丸棒。ひび割れ注入・アンカーボルト", build_bar),
    Shape(u"sphere", u"半径", u"中心", u"球。点の印", build_sphere),
):
    SHAPES[_s.key] = _s


def needs_cells(row):
    u"""その行が要る座標セルの数。数えられない形式は None。"""
    spec = SHAPES.get(row.model)
    if spec is None or spec.needs is None:
        return None
    try:
        return spec.needs(row)
    except (TypeError, ValueError):
        return None


def group_rows(book):
    u"""まとめ列が同じ行を1つの物体にする。

    ifc_exchange の SOLIDUNION/SOLIDEND のような「印の行」は使わない。
    シートは1行=1補修箇所で行の挿入も禁止なので、印の行を置く場所が無いし、
    並べ替えで壊れる。**同じ名前を書いた行がまとまる**なら順番に依存しない。

    まとめ名が空の行は、その行だけで1つの物体（今までどおり）。
    名前・タイプ・工程・メモは**先頭の行**のものを使う。
    """
    groups, index = [], {}
    for row in book.rows:
        key = row.group.strip()
        if key == u"":
            groups.append([row])
            continue
        if key not in index:
            index[key] = len(groups)
            groups.append([])
        groups[index[key]].append(row)
    return groups


# 表現の種類は中身に合わせる（IFC2X3）
SOLID_KINDS = (u"Brep", u"SweptSolid", u"CSG", u"AdvancedSweptSolid")


def merge_kind(kinds):
    u"""まとめた中身から RepresentationType を決める。"""
    uniq = set(kinds)
    if len(uniq) == 1:
        return list(uniq)[0]
    if uniq <= set(SOLID_KINDS):
        return u"SolidModel"        # 立体どうしの混在
    return u"SurfaceModel"          # 面が混ざっているとき


def write_ifc(book, out_path, include_hidden=False, index=None):
    u"""1つの物体 = IFCBUILDINGELEMENTPROXY 1個。まとまり(STOREY)は タイプ-施工段階。

    index にリストを渡すと (物体の GUID, [行番号...]) を足していく（アプリが
    画面で押した物体から行を引くため）。
    """
    f = IfcFile()
    milli = u".MILLI." if book.unit == u"mm" else u"$"

    org = f.add(u"IFCORGANIZATION($,'Terra Drone',$,$,$)")
    person = f.add(u"IFCPERSON($,$,'',$,$,$,$,$)")
    p_and_o = f.add(u"IFCPERSONANDORGANIZATION(%s,%s,$)" % (person, org))
    app = f.add(u"IFCAPPLICATION(%s,'1.0','sheet_to_ifc','sheet_to_ifc')" % org)
    stamp = int((datetime.datetime.now() - datetime.datetime(1970, 1, 1)).total_seconds())
    owner = f.add(u"IFCOWNERHISTORY(%s,%s,$,.NOCHANGE.,$,$,$,%d)" % (p_and_o, app, stamp))

    origin = f.add(u"IFCCARTESIANPOINT((0.,0.,0.))")
    dir_z = f.add(u"IFCDIRECTION((0.,0.,1.))")
    dir_x = f.add(u"IFCDIRECTION((1.,0.,0.))")
    axis = f.add(u"IFCAXIS2PLACEMENT3D(%s,%s,%s)" % (origin, dir_z, dir_x))
    ctx = f.add(u"IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,2.54E-8,%s,$)" % axis)
    sub = f.add(u"IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,%s,$,"
                u".MODEL_VIEW.,$)" % ctx)

    units = [f.add(u"IFCSIUNIT(*,.LENGTHUNIT.,%s,.METRE.)" % milli),
             f.add(u"IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)"),
             f.add(u"IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)")]
    rad = f.add(u"IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)")
    mwu = f.add(u"IFCMEASUREWITHUNIT(IFCREAL(0.0174532925199433),%s)" % rad)
    dim = f.add(u"IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0)")
    units.append(f.add(u"IFCCONVERSIONBASEDUNIT(%s,.PLANEANGLEUNIT.,'degree',%s)" % (dim, mwu)))
    units.append(f.add(u"IFCSIUNIT(*,.TIMEUNIT.,$,.SECOND.)"))
    units.append(f.add(u"IFCSIUNIT(*,.MASSUNIT.,$,.GRAM.)"))
    unit_asg = f.add(u"IFCUNITASSIGNMENT((%s))" % u",".join(units))

    # ★★引いた分を【敷地の配置】へ入れると、その点だけが 180 km 先に残る。
    #   画面合わせでそこまで含めるビューアがあるので、**配置は原点のまま**にし、
    #   引いた分は IfcProject の説明に文字で残す（2026-09-09）。
    #   戻すときは各座標にこの値を足す
    place_site = f.add(u"IFCLOCALPLACEMENT($,%s)" % axis)
    place_bldg = f.add(u"IFCLOCALPLACEMENT(%s,%s)" % (place_site, axis))

    stem = os.path.splitext(os.path.basename(book.source))[0]
    desc = (u"$" if BASE == (0.0, 0.0, 0.0)
            else ifc_str(u"base=%.3f,%.3f,%.3f" % BASE))
    project = f.add(u"IFCPROJECT(%s,%s,%s,%s,$,$,$,(%s),%s)"
                    % (q(ifc_guid(u"project:" + stem)), owner, ifc_str(stem),
                       desc, ctx, unit_asg))
    site = f.add(u"IFCSITE(%s,%s,'Default',$,$,%s,$,$,.ELEMENT.,$,$,0.,$,$)"
                 % (q(ifc_guid(u"site:" + stem)), owner, place_site))
    building = f.add(u"IFCBUILDING(%s,%s,%s,$,$,%s,$,$,.ELEMENT.,$,$,$)"
                     % (q(ifc_guid(u"building:" + stem)), owner,
                        ifc_str(u"補修モデル"), place_bldg))

    def color_style(rgb_text, transp):
        def make():
            col = f.add(u"IFCCOLOURRGB($,%s)" % rgb_text)
            if transp <= 0:
                sh = f.add(u"IFCSURFACESTYLESHADING(%s)" % col)
                st = f.add(u"IFCSURFACESTYLE($,.POSITIVE.,(%s))" % sh)
            else:
                sh = f.add(u"IFCSURFACESTYLERENDERING(%s,%s,$,$,$,$,"
                           u"IFCNORMALISEDRATIOMEASURE(0.5),IFCSPECULAREXPONENT(12.),"
                           u".NOTDEFINED.)" % (col, num(transp)))
                st = f.add(u"IFCSURFACESTYLE($,.BOTH.,(%s))" % sh)
            return f.add(u"IFCPRESENTATIONSTYLEASSIGNMENT((%s))" % st)
        return f.once((u"style", rgb_text, transp), make)

    storeys = collections.OrderedDict()
    written, skipped, seen = 0, [], collections.Counter()

    for members in group_rows(book):
        head = members[0]
        rv = Resolved(head, book.palette)
        if not rv.visible and not include_hidden:
            for row in members:
                skipped.append((row.row, u"透過1（見えない設定）"))
            continue

        bodies, kinds = [], []
        for row in members:
            member_rv = rv if row is head else Resolved(row, book.palette)
            try:
                shape = build_shape(f, row)
            except Exception as e:
                shape = None
                skipped.append((row.row, u"形が作れない: %s" % e))
            if shape is None:
                if not skipped or skipped[-1][0] != row.row:
                    skipped.append((row.row, u"形が無い"))
                continue
            body, kind = shape
            bodies.append(body)
            kinds.append(kind)
            # 色は形ごとに付ける。まとめても部材ごとの色分けが残る
            rgb_text = norm_rgb(member_rv.rgb) if member_rv.rgb else u"0.5,0.5,0.5"
            f.add(u"IFCSTYLEDITEM(%s,(%s),$)"
                  % (body, color_style(rgb_text, member_rv.transp)))
        if not bodies:
            continue

        key = u"|".join([head.type, head.name] + head.memos +
                        [head.group or (head.coords[0] or u"")])
        seen[key] += 1
        if seen[key] > 1:
            key = u"%s#%d" % (key, seen[key])

        rep = f.add(u"IFCSHAPEREPRESENTATION(%s,'Body','%s',(%s))"
                    % (sub, merge_kind(kinds), u",".join(bodies)))
        pds = f.add(u"IFCPRODUCTDEFINITIONSHAPE($,$,(%s))" % rep)
        place = f.add(u"IFCLOCALPLACEMENT(%s,%s)" % (place_bldg, axis))
        proxy = f.add(u"IFCBUILDINGELEMENTPROXY(%s,%s,%s,$,$,%s,%s,$,$)"
                      % (q(ifc_guid(u"proxy:" + key)), owner, ifc_str(head.name), place, pds))
        if index is not None:
            index.append((ifc_guid(u"proxy:" + key), [row.row for row in members]))

        props = []
        for i, h in enumerate(book.step_heads):
            label = rv.step_labels[i] if i < len(rv.step_labels) else u""
            if len(label) <= 1:
                continue                       # 1文字の段階名は使わない（元の仕様）
            props.append(f.add(u"IFCPROPERTYSINGLEVALUE(%s,$,IFCLABEL(%s),$)"
                               % (ifc_str(h), ifc_str(u"%s:%s" % (label, head.steps[i])))))
        for i, h in enumerate(book.memo_heads):
            props.append(f.add(u"IFCPROPERTYSINGLEVALUE(%s,$,IFCLABEL(%s),$)"
                               % (ifc_str(h), ifc_str(head.memos[i]))))
        if len(members) > 1:
            props.append(f.add(u"IFCPROPERTYSINGLEVALUE(%s,$,IFCLABEL(%s),$)"
                               % (ifc_str(book.group_head or u"まとめ"),
                                  ifc_str(u"%s（%d 行）" % (head.group, len(members))))))
        if props:
            pset = f.add(u"IFCPROPERTYSET(%s,%s,%s,$,(%s))"
                         % (q(ifc_guid(u"pset:" + key)), owner, ifc_str(u"属性"),
                            u",".join(props)))
            f.add(u"IFCRELDEFINESBYPROPERTIES(%s,%s,$,$,(%s),%s)"
                  % (q(ifc_guid(u"rel:" + key)), owner, proxy, pset))

        storeys.setdefault(rv.storey, []).append(proxy)
        written += 1

    storey_refs = []
    for sname, proxies in storeys.items():
        place = f.add(u"IFCLOCALPLACEMENT(%s,%s)" % (place_bldg, axis))
        st = f.add(u"IFCBUILDINGSTOREY(%s,%s,%s,$,$,%s,$,$,.ELEMENT.,0.)"
                   % (q(ifc_guid(u"storey:" + sname)), owner, ifc_str(sname), place))
        f.add(u"IFCRELCONTAINEDINSPATIALSTRUCTURE(%s,%s,$,$,(%s),%s)"
              % (q(ifc_guid(u"contains:" + sname)), owner, u",".join(proxies), st))
        storey_refs.append(st)

    f.add(u"IFCRELAGGREGATES(%s,%s,$,$,%s,(%s))"
          % (q(ifc_guid(u"agg:project")), owner, project, site))
    f.add(u"IFCRELAGGREGATES(%s,%s,$,$,%s,(%s))"
          % (q(ifc_guid(u"agg:site")), owner, site, building))
    if storey_refs:
        f.add(u"IFCRELAGGREGATES(%s,%s,$,$,%s,(%s))"
              % (q(ifc_guid(u"agg:building")), owner, building, u",".join(storey_refs)))

    now = datetime.datetime.now().strftime(u"%Y-%m-%dT%H:%M:%S")
    head_lines = [u"ISO-10303-21;", u"HEADER;",
                  u"FILE_DESCRIPTION(('ViewDefinition [CoordinationView_V2.0]'),'2;1');",
                  u"FILE_NAME(%s,'%s',(''),(''),'sheet_to_ifc','Terra Drone','');"
                  % (ifc_str(os.path.basename(out_path)), now),
                  u"FILE_SCHEMA(('IFC2X3'));", u"ENDSEC;", u"DATA;"]
    tail = [u"ENDSEC;", u"END-ISO-10303-21;", u""]
    with io.open(out_path, "w", encoding="utf-8", newline=u"\n") as fp:
        fp.write(u"\n".join(head_lines + f.lines + tail))
    return written, skipped, list(storeys.keys())


# ============================================================ 入口

def load(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (u".xlsm", u".xlsx"):
        return read_xlsm(path)
    return read_tsv(path)


def main(argv=None):
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("input", nargs="?")
    ap.add_argument("output", nargs="?")
    ap.add_argument("--check-only", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--include-hidden", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--shapes", action="store_true")
    ap.add_argument("--to-tsv", default="",
                    help=u"IFC を作らず、読んだ中身をアプリ用の TSV に書く")
    ap.add_argument("--to-csv", default="",
                    help=u"IFC を作らず、一覧を CSV（UTF-8 BOM）に書く")
    ap.add_argument("--base", default="",
                    help=u"原点をずらす。auto か x,y,z。"
                         u"ずらした分は IfcSite の配置に入る")
    ap.add_argument("-h", "--help", action="store_true")
    a = ap.parse_args(argv)
    out = out_stream()
    if a.shapes:
        out.write(u"AD列(形式) に書ける言葉\n\n")
        for k, sp in SHAPES.items():
            out.write(u"  %-10s AE列=%-8s AF以降=%s\n             %s\n"
                      % (k, sp.ae, sp.af, sp.note))
        out.flush()
        return 0
    if a.help or not a.input:
        out.write(__doc__)
        out.flush()
        return 2
    if not os.path.exists(a.input):
        out.write(u"入力が無い: %s\n" % a.input)
        out.flush()
        return 2

    try:
        book = load(a.input)
    except SystemExit as e:
        out.write(u"%s\n" % e)
        out.flush()
        return 2
    except Exception as e:                                  # 読めない = 使えない
        out.write(u"読み込みに失敗した: %s: %s\n" % (type(e).__name__, e))
        out.flush()
        return 2

    # ★原点をずらす（遠い座標だとビューアが画面を合わせられない）
    if a.base:
        global BASE
        if a.base == u"auto":
            vs = []
            for row in book.rows:
                for t in row.coords:
                    try:
                        vs.append(triple(t))
                    except Exception:
                        pass
            if vs:
                A = list(zip(*vs))
                BASE = tuple(round((min(c) + max(c)) / 2.0, 3) for c in A)
        else:
            BASE = triple(a.base)
        if not a.quiet:
            out.write(u"原点を %s ずらす" % (BASE,) + chr(10))

    if a.to_tsv or a.to_csv:
        if a.to_tsv:
            with io.open(a.to_tsv, "w", encoding="utf-8", newline=u"") as fp:
                write_tsv(book, fp)
            out.write(u"TSV: %s（%d 行）\n" % (a.to_tsv, len(book.rows)))
        if a.to_csv:
            with io.open(a.to_csv, "w", encoding="utf-8-sig", newline=u"") as fp:
                write_csv(book, fp)
            out.write(u"CSV: %s（%d 行）\n" % (a.to_csv, len(book.rows)))
        out.flush()
        return 0

    found = check(book)
    errors = [x for x in found if is_error(x[1])]
    warns = [x for x in found if not is_error(x[1])]

    if not a.quiet:
        out.write(u"入力: %s\n" % book.source)
        out.write(u"行 %d / 単位 %s / タイプ %d / 色 %d\n"
                  % (len(book.rows), book.unit,
                     len(book.palette.types) - 1, len(book.palette.colors)))
        for tag, items in ((u"エラー", errors), (u"注意", warns)):
            shown = collections.Counter()
            out.write(u"\n== %s %d 件 %s\n"
                      % (tag, len(items),
                         dict(collections.Counter(c for _, c, _ in items))))
            for r, c, msg in items:
                shown[c] += 1
                if shown[c] <= 10:
                    out.write(u"  %4d行 %s %s\n" % (r, c, msg))
                elif shown[c] == 11:
                    out.write(u"       %s … 以下同じものは省略\n" % c)

    if a.check_only:
        out.flush()
        return 1 if errors else 0
    if errors and not a.force:
        out.write(u"\nエラーがあるので書かなかった。直すか --force。\n")
        out.flush()
        return 1

    out_path = a.output or os.path.join(os.path.dirname(os.path.abspath(a.input)),
                                        u"repairmodel.ifc")
    try:
        written, skipped, storeys = write_ifc(book, out_path, a.include_hidden)
    except IOError as e:
        out.write(u"\n書けなかった（Navisworks などが掴んでいないか）: %s\n" % e)
        out.flush()
        return 1

    out.write(u"\n出力: %s\n" % out_path)
    out.write(u"物体 %d 個 / まとまり %d 個 / 出さなかった行 %d\n"
              % (written, len(storeys), len(skipped)))
    if not a.quiet:
        for s in storeys:
            out.write(u"  %s\n" % s)
    out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
