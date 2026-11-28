"""スキル欄の「潜在解放」用データ bf-potential.json を作る.
元はエンチャントDBの data.json（sk: スキル→関係する潜在系エンチャ、desc: 説明文）。
固定詠唱(f)・CT(c)に関係するものだけ、分けて持つ。s は効果に要るセット相手（「豪傑とセット」なら豪傑）。
使い方: python3 tools-bf-potential.py [data.json]
"""
import json, re, sys

src = sys.argv[1] if len(sys.argv) > 1 else "/mnt/project-files/enchant-db/v2/site/data.json"
d = json.load(open(src, encoding="utf-8"))
sk, en = {}, {}
for name, v in d["sk"].items():
	got = {key: [n for n in (v.get(key) or [[]])[0] if isinstance(n, str)] for key in ("f", "c")}
	if not got["f"] and not got["c"]: continue
	sk[re.sub(r"\s+", "", name)] = got
	for n in got["f"] + got["c"]:
		if n in en: continue
		desc = d["desc"].get(n, "")
		partners = []
		for head, rest in re.findall(r"\x02(.*?)とセット：\x03?([^\n]*)", desc):
			head = head.strip()
			if head == "次のどれか": partners = [rest.replace("\x03", "").split("／")[0].strip()]
			else: partners = [x.strip() for x in head.split("＋")]
			break
		en[n] = {"d": desc, "s": partners}
json.dump({"sk": sk, "en": en}, open("bf-potential.json", "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(len(sk), "skills", len(en), "enchants")
