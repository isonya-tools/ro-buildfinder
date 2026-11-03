// RO BuildFinder: 計算処理がIDを直接見ている装備・カード（bf-hard.json の各分類）を、1つずつ実際に装備して
// どの指標が変わるかを調べる。4次職（2職まで）・ステータス130・精錬値 0〜20 で試す。
// calcx.html を開いた状態で、この本体を async 関数としてページ内で実行する（10分ほど）。
// 結果の metrics を bf-hard.json の "probe" に入れる。
const E = await import('/ro4/m/buildfinder/bf-engine.js');
const {readMetrics} = await import('/ro4/m/buildfinder/bf-metrics.js');
const {ItemObjNew} = await import('/engine/equip/item.dat.js');
const {CardObjNew} = await import('/engine/equip/card.dat.js');
const {IsMatchJobRestrict} = await import('/engine/data/mig.job.h.js');
const {get: reg} = await import('/engine/runtime/engine-registry.js');
const CK = await import('/engine/const/EnumCardKind.js');
const hard = await (await fetch('/ro4/m/buildfinder/bf-hard.json')).json();
const LIMIT = Number(window.__LIMIT || 1e9);
const items = [...new Set(Object.values(hard).flatMap((c) => c.items))].filter((i) => ItemObjNew[i]).slice(0, LIMIT);
const cards = [...new Set(Object.values(hard).flatMap((c) => c.cards))].filter((i) => CardObjNew[i]).slice(0, LIMIT);
const JOBS = Array.from({length: 23}, (_, i) => 66 + i);
const LV = [0, 4, 7, 9, 10, 11, 12, 13, 15, 20];
const regionOfItem = (id) => { const k = ItemObjNew[id][1]; if (k >= 1 && k <= 22) return E.BF_REGIONS[0]; return E.BF_REGIONS.find((r) => r.kinds?.includes(k)); };
const regionOfCard = (id) => { const k = CardObjNew[id][1]; return E.BF_REGIONS.find((r) => r.cardKinds.includes(k)) || E.BF_REGIONS.find((r) => r.key === 'body'); };
const setRefine = (m, r, v) => { if (r.refine === 'weapon') m.weapon.atkPlus = v; else if (r.refine) m.defPlus[r.refine] = v; };
const clear = (m, r) => { m.equip[r.eq] = r.empty; for (const s of r.slots) m.card[s] = 0; };
const ev = (m) => { try { return readMetrics(reg('calcCoreFromModel')(m)); } catch { return null; } };
const out = {}; const add = (key, kind, id) => { (out[key] ??= {items: new Set(), cards: new Set()})[kind].add(id); };
const sel = document.getElementById('OBJID_SELECT_JOB');
const jobModel = {};
const getBase = (job) => {
  if (!jobModel[job]) {
    sel.value = String(job); sel.dispatchEvent(new Event('change', {bubbles: true}));
    const m = reg('extractModelFromDom')();
    Object.assign(m.status, {baseLv: 275, jobLv: 60, str: 130, agi: 130, vit: 130, dex: 130, int: 130, luk: 130});
    m.timeItemConf = m.timeItemConf.map(() => 0);
    for (const r of E.BF_REGIONS) if (r.key !== 'weapon') clear(m, r); else for (const s of r.slots) m.card[s] = 0;
    jobModel[job] = m;
  }
  return jobModel[job];
};
const baseCache = new Map();
const baseVal = (job, r, lv, weapon) => {
  const k = job + ':' + r.key + ':' + lv + ':' + (weapon || '');
  if (!baseCache.has(k)) { const m = structuredClone(getBase(job)); if (weapon) { m.equip[r.eq] = weapon; m.weapon.type = ItemObjNew[weapon][1]; } clear(m, r); if (weapon) { m.equip[r.eq] = weapon; } setRefine(m, r, lv); baseCache.set(k, ev(m)); }
  return baseCache.get(k);
};
const diff = (a, b, kind, id) => { if (!a || !b) return; for (const key of Object.keys(b)) { const x = a[key], y = b[key]; if (typeof y === 'number' && !Number.isNaN(y) && x !== y) add(key, kind, id); } };
const t0 = performance.now(); let n = 0;
for (const id of items) {
  const r = regionOfItem(id); if (!r) continue;
  const jobs = JOBS.filter((j) => IsMatchJobRestrict(id, j)).slice(0, 2);
  for (const job of jobs) for (const lv of (r.refine ? LV : [0])) {
    const m = structuredClone(getBase(job)); clear(m, r); m.equip[r.eq] = id; if (r.key === 'weapon') m.weapon.type = ItemObjNew[id][1]; setRefine(m, r, lv);
    // 武器は「素手」基準ではなく同じ精錬の素手と比べる
    diff(baseVal(job, r, lv), ev(m), 'items', id); n++;
  }
}
for (const id of cards) {
  const r = regionOfCard(id);
  const slot = CardObjNew[id][1] === CK.CARD_KIND_ENCHANT ? r.slots[1] : r.slots[0];
  for (const job of [66, 70]) for (const lv of (r.refine ? LV : [0])) {
    const m = structuredClone(getBase(job)); clear(m, r); setRefine(m, r, lv); m.card[slot] = id;
    diff(baseVal(job, r, lv), ev(m), 'cards', id); n++;
  }
}
const res = {}; for (const [k, v] of Object.entries(out)) res[k] = {items: [...v.items].sort((a, b) => a - b), cards: [...v.cards].sort((a, b) => a - b)};
return JSON.stringify({n, sec: Math.round((performance.now() - t0) / 1000), items: items.length, cards: cards.length, metrics: res});
