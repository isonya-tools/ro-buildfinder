import urllib.request,sys,time
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
for u,f in [("cms/news/408","n408"),("cms/news/404","n404"),("cms/news/403","n403"),("cms/skillrenewal2612-pre","skillpre")]:
    try:
        d=urllib.request.urlopen(urllib.request.Request("https://ragnarokonline.gungho.jp/"+u,headers={"User-Agent":UA}),timeout=30).read()
        open(f+".html","wb").write(d);print(u,len(d))
    except Exception as e: print(u,"ERR",e);break
    time.sleep(3.5)
