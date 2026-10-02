# -*- coding: utf-8 -*-
u"""施工段階アプリの中身（ブラウザの Pyodide で動く）。

IFC を組むのは tools/sheet_to_ifc.py そのもの。ここは画面とのやりとりだけ。
正のファイルは sheet_to_ifc.read_tsv の形の TSV（write_tsv で書き戻す）。
画面へは JSON の文字列で渡す。
"""
import io, json, re
import sheet_to_ifc as S

BOOK = None
DATE_RE = re.compile(u"^\\d{4}/\\d{1,2}/\\d{1,2}$")


def _row_json(r):
    rv = S.Resolved(r, BOOK.palette)
    return {
        u"row": r.row, u"name": r.name, u"type": r.type,
        u"steps": list(r.steps), u"memos": list(r.memos), u"group": r.group,
        u"model": r.model, u"step": rv.step, u"stage": rv.stage,
        u"color": rv.color, u"rgb": list(rv.rgb) if rv.rgb else None,
        u"transp": rv.transp, u"hole": r.has_step_hole,
    }


def _types_json():
    out = {}
    for name, block in BOOK.palette.types.items():
        if name == S.DEFAULT_TYPE:
            continue
        out[name] = {
            u"names": [BOOK.palette.cell(name, S.LABEL_NAME, s) for s in range(S.NSTEP)],
            u"colors": [BOOK.palette.cell(name, S.LABEL_COLOR, s) for s in range(S.NSTEP)],
            u"transp": [BOOK.palette.cell(name, S.LABEL_TRANSP, s) for s in range(S.NSTEP)],
        }
    return out


def _findings():
    return [{u"row": r, u"code": c, u"msg": m} for r, c, m in S.check(BOOK)]


def load(text, source):
    u"""TSV の中身を読む。"""
    global BOOK
    with io.open(u"/tmp/in.tsv", u"w", encoding=u"utf-8", newline=u"") as fp:
        fp.write(text)
    BOOK = S.read_tsv(u"/tmp/in.tsv")
    # #book は残す。IfcProject などの GUID がブック名から決まるので、
    # エクセルの頃に上げた IFC と同じ GUID を保つ（無いときだけファイル名）
    if BOOK.source == u"/tmp/in.tsv":
        BOOK.source = source
    return state()


def state():
    return json.dumps({
        u"source": BOOK.source, u"unit": BOOK.unit,
        u"stepHeads": BOOK.step_heads, u"memoHeads": BOOK.memo_heads,
        u"groupHead": BOOK.group_head,
        u"colors": {k: list(v) for k, v in BOOK.palette.colors.items()},
        u"types": _types_json(),
        u"rows": [_row_json(r) for r in BOOK.rows],
        u"findings": _findings(),
    }, ensure_ascii=False)


def set_steps(changes_json):
    u"""[[行番号, STEPの添字(0起点), 値], ...] を入れる。値は 2026/10/02 か空。

    日付の形でない値は入れずに返す。変わった行だけを返す。
    """
    changes = json.loads(changes_json)
    by_row = {r.row: r for r in BOOK.rows}
    touched, rejected = [], []
    for row_no, idx, value in changes:
        r = by_row.get(int(row_no))
        value = (value or u"").strip()
        if r is None or not (0 <= int(idx) < len(r.steps)):
            rejected.append([row_no, idx, value, u"行か STEP が無い"])
            continue
        if value != u"" and not DATE_RE.match(value):
            rejected.append([row_no, idx, value, u"日付の形でない（2026/10/02 の形）"])
            continue
        r.steps[int(idx)] = value
        touched.append(r)
    return json.dumps({
        u"rows": [_row_json(r) for r in touched],
        u"rejected": rejected,
        u"findings": _findings(),
    }, ensure_ascii=False)


def tsv():
    buf = io.StringIO()
    S.write_tsv(BOOK, buf)
    return buf.getvalue()


def csv():
    buf = io.StringIO()
    S.write_csv(BOOK, buf)
    return u"﻿" + buf.getvalue()


def ifc(include_hidden, out_name):
    u"""IFC の中身と (GUID → 行番号) の表。

    include_hidden=True は画面用（透過1の行も形を出し、画面側で薄く見せる）。
    アップロード用は False（sheet_to_ifc.exe と同じ）。
    """
    index = []
    path = u"/tmp/" + out_name
    written, skipped, storeys = S.write_ifc(BOOK, path, bool(include_hidden), index)
    with io.open(path, encoding=u"utf-8") as fp:
        text = fp.read()
    return json.dumps({
        u"ifc": text, u"index": index, u"written": written,
        u"skipped": len(skipped), u"storeys": storeys,
    }, ensure_ascii=False)
