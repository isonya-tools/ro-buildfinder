"""RO BuildFinder: 公式の強化・エンチャント情報（エンチャ検索 enchant-db の data.json）から、
装備ごとに付けられるエンチャント名の一覧と、超越段階の条件（trans: 付けるのに要る最小の★。条件なしは載せない）を作る。らとりおのエンチャントデータと食い違うもの
（公式にない組み合わせ）を検索候補から外すのに使う。

python3 ro4/m/buildfinder/tools-bf-official.py /mnt/project-files/enchant-db/v2/site/data.json > ro4/m/buildfinder/bf-official-ench.json
"""
import json
import re
import sys


def norm(s):
    s = re.sub(r"\[\d+\]$", "", s.strip())
    return re.sub(r"[\s　]", "", s)


d = json.load(open(sys.argv[1], encoding="utf-8"))
names, index = [], {}
items = {}
trans = {}
TRANS_RE = re.compile(r"超越段階(\d)以上")


def need_trans(*texts):
    t = 0
    for x in texts:
        for m in TRANS_RE.finditer(x or ""):
            t = max(t, int(m.group(1)))
    return t
for it in d["items"]:
    got = set()
    tmin = {}  # エンチャント → 付けられる最小の超越段階（どこかで条件なしなら0）
    for ri in it["e"]:
        rec = d["recs"][ri]
        for st in rec["steps"]:
            t = need_trans(st.get("c", ""), *rec.get("req", []))
            for o in st["o"]:
                n = norm(o)
                if n not in index:
                    index[n] = len(names)
                    names.append(n)
                got.add(index[n])
                tmin[index[n]] = min(tmin.get(index[n], 9), t)
    if not got:
        continue
    tneed = {i: t for i, t in tmin.items() if t > 0}
    for nm in {it["n"], *it.get("v", [])}:
        items.setdefault(norm(nm), set()).update(got)
        if tneed:
            cur = trans.setdefault(norm(nm), {})
            for i, t in tneed.items():
                cur[i] = min(cur.get(i, 9), t) if i in cur else t
        else:
            trans.setdefault(norm(nm), {})
# 同じ名前で条件なしの一覧もあれば、条件なしとみなす（上の min で処理）。空は捨てる
trans = {k: {str(i): t for i, t in v.items()} for k, v in trans.items() if v}
out = {"date": d.get("date"), "names": names, "items": {k: sorted(v) for k, v in items.items()}, "trans": trans}
json.dump(out, sys.stdout, ensure_ascii=False, separators=(",", ":"))
