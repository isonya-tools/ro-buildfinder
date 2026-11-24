import json,glob,html,re,time,urllib.request,urllib.parse
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
last=0
def get(u):
    global last
    w=3.5-(time.time()-last)
    if w>0: time.sleep(w)
    try:
        return urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":UA}),timeout=30).read().decode("utf-8","replace")
    finally: last=time.time()
by={}
for f in glob.glob("../../EnchantDB/new_20261117/rotool_cache/*.json"):
    for it in json.load(open(f,encoding="utf-8")): by.setdefault(html.unescape(it['item_name']),{})[it['item_id']]=1
ch=json.load(open("B_changed_items.json",encoding="utf-8"))
names=[]
for v in ch.values():
    for n in v:
        if n not in names: names.append(n)
for n in ["王女メアカード","半龍王女メアカード","英雄マント[1]","サバイバルマント[0]","サバイバルマント[1]","異境の統轄者"]:
    if n not in names: names.append(n)
res={}
def desc(i):
    p=get(f"https://rotool.gungho.jp/item/{i}/0/")
    m=re.search(r'<div class="description">(.*?)</div>',p,re.S)
    if not m: return None
    s=re.sub(r"<br\s*/?>","\n",m.group(1),flags=re.I)
    return html.unescape(re.sub(r"<[^>]+>","",s)).strip()
# C first
q=get("https://rotool.gungho.jp/item/prediction_conversion_search_name/?item_name="+urllib.parse.quote("パープルスター"))
json.dump({"raw":q},open("C_search_raw.json","w",encoding="utf-8"),ensure_ascii=False)
try:
    for it in json.loads(q):
        if "パープルスター" in it['item_name']: print("C",it)
except Exception as e: print("C parse",e,q[:200])
for n in names:
    ids=list(by.get(n,{}))
    if not ids:
        q=get("https://rotool.gungho.jp/item/prediction_conversion_search_name/?item_name="+urllib.parse.quote(n))
        try: ids=[x['item_id'] for x in json.loads(q) if html.unescape(x['item_name'])==n]
        except: ids=[]
    res[n]={"ids":ids,"desc":{i:desc(i) for i in ids}}
    print(n,ids,flush=True)
json.dump(res,open("B_rotool_raw.json","w",encoding="utf-8"),ensure_ascii=False,indent=1)
print("done")
