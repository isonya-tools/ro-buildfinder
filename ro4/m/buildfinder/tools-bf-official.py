"""RO BuildFinder: 公式の強化・エンチャント情報（エンチャ検索 enchant-db の data.json）から、
装備ごとに付けられるエンチャント名の一覧を作る。らとりおのエンチャントデータと食い違うもの
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
for it in d["items"]:
    got = set()
    for ri in it["e"]:
        for st in d["recs"][ri]["steps"]:
            for o in st["o"]:
                n = norm(o)
                if n not in index:
                    index[n] = len(names)
                    names.append(n)
                got.add(index[n])
    if not got:
        continue
    for nm in {it["n"], *it.get("v", [])}:
        items.setdefault(norm(nm), set()).update(got)
out = {"date": d.get("date"), "names": names, "items": {k: sorted(v) for k, v in items.items()}}
json.dump(out, sys.stdout, ensure_ascii=False, separators=(",", ":"))
