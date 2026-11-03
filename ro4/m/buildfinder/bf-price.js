/**
 * 値段データ（prices_noatun.json.gz）の読み込みと、探索用の値段関数.
 * 値段更新プログラム（PC側 RO_Tools\BuildFinderPrice\update_prices.py → make_noatun.py）が作る、ノアトゥン（N鯖）だけの値段。
 *   items: {公式ID: {n: 名前[スロット数], k: e|c|p, p: [中央値, 件数, 遡った月数]}}
 *   g: {公式ID: [[精錬値, card1, card2, card3, card4, 中央値, 件数, 月数], ...]}（装備の、精錬値とカード・エンチャの組ごとの値段）
 */
import { itemName, cardName, itemSlotCount } from "./bf-engine.js";

const SLOT_RE = /^(.*)\[(\d+)\]$/;
const norm = (s) => String(s ?? "").replace(/\s+/g, "").replace(SLOT_RE, "$1");
// 値段データのカード名は「イーブルカード」、ラトリオは「イーブル」なので、末尾の「カード」を外して比べる
const cardNorm = (s) => norm(s).replace(/[<>＜＞]/g, "").replace(/カード$/, "");
// 同名で枠数違い（[0] と [3] など）は別の装備なので、らとりおの枠数と同じものだけを見る（無ければ全部）。その中で一番安い値段を使う
const slotOf = (n) => { const m = SLOT_RE.exec(String(n ?? "").replace(/\s+/g, "")); return m ? Number(m[2]) : null; };

export async function loadPrices() {
	try {
		const res = await fetch(new URL("./prices_noatun.json.gz", import.meta.url), { cache: "no-cache" });
		if (!res.ok) return null;
		// サーバーによっては gzip を展開して返すので、先頭の2バイトで判定する
		const buf = new Uint8Array(await res.arrayBuffer());
		const text = buf[0] === 0x1f && buf[1] === 0x8b
			? await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).text()
			: new TextDecoder().decode(buf);
		const data = JSON.parse(text);
		const byName = new Map();
		for (const [oid, it] of Object.entries(data.items || {})) {
			const base = it.k === "c" ? "c:" + cardNorm(it.n) : norm(it.n);
			if (!byName.has(base)) byName.set(base, []);
			byName.get(base).push({ oid, ...it, rows: data.g?.[oid] || [] });
		}
		data.byName = byName;
		return data;
	} catch (e) {
		console.warn("値段データを読めませんでした", e);
		return null;
	}
}

/**
 * search() に渡す値段関数.
 *   priceOf("item", id) / priceOf("card", id): 一番安い値段
 *   priceOf("itemEnch", id, [エンチャントID...], 精錬値): そのエンチャントがすべて付き、精錬値がそれ以上の取引の中で一番安い値段（無ければ null）
 */
export function priceOfFactory(prices) {
	if (!prices) return () => null;
	const cache = new Map();
	const cands = (name, id) => {
		const all = prices.byName.get(norm(name)) || [];
		if (all.length < 2) return all;
		const n = itemSlotCount(id);
		const same = all.filter((c) => slotOf(c.n) === n);
		return same.length ? same : all;
	};
	const cardCands = (name) => prices.byName.get("c:" + cardNorm(name)) || [];
	// 目安（取引が少ない・古い）: 取引2件以下、または6か月以上前まで遡った値段
	const weak = new Set();
	const isWeak = (cnt, months) => !(cnt >= 3) || months >= 6;
	const f = (kind, id, ench, refine = 0) => {
		const key = kind + ":" + id + (ench ? ":" + ench.join(",") + ":" + refine : "");
		if (cache.has(key)) return cache.get(key);
		let v = null, w = false;
		if (kind === "item" || kind === "card") {
			for (const c of kind === "item" ? cands(itemName(id), id) : cardCands(cardName(id))) {
				const p = c.p?.[0];
				if (p != null && (v == null || p < v)) { v = p; w = isWeak(c.p[1], c.p[2]); }
			}
		} else if (kind === "itemEnch") {
			const need = ench.map((cid) => cardNorm(cardName(cid)));
			for (const c of cands(itemName(id), id)) {
				for (const row of c.rows) {
					if ((Number(row[0]) || 0) < refine) continue;
					const have = row.slice(1, 5).map(cardNorm);
					const ok = need.every((n) => { const i = have.indexOf(n); if (i < 0) return false; have[i] = null; return true; });
					if (ok && (v == null || row[5] < v)) { v = row[5]; w = isWeak(row[6], row[7]); }
				}
			}
		}
		cache.set(key, v);
		if (w) weak.add(key);
		return v;
	};
	/** その値段が目安（取引が少ない・古い）か。先に同じ引数で値段を引いておくこと */
	f.weak = (kind, id, ench, refine = 0) => weak.has(kind + ":" + id + (ench ? ":" + ench.join(",") + ":" + refine : ""));
	return f;
}

/** 値段データのある装備・カードの割合（確認用） */
export function priceCoverage(prices, names) {
	let hit = 0;
	for (const n of names) if (prices?.byName.has(norm(n)) || prices?.byName.has("c:" + cardNorm(n))) hit++;
	return hit / (names.length || 1);
}
