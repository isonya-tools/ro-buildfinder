import re,html,sys
for f in sys.argv[1:]:
    s=open(f,encoding="utf-8",errors="replace").read()
    s=re.sub(r"<(script|style)[^>]*>.*?</\1>","",s,flags=re.S)
    s=re.sub(r"<br\s*/?>|</p>|</li>|</tr>|</h\d>|</div>","\n",s,flags=re.I)
    s=html.unescape(re.sub(r"<[^>]+>","",s))
    s=re.sub(r"\n\s*\n+","\n",s)
    open(f.replace(".html",".txt"),"w",encoding="utf-8").write(s);print(f,len(s))
