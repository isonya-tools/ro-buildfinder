/**
 * 値段データ（prices.json）の読み込みと、探索用の値段関数.
 * prices.json は値段更新プログラム（PC側 RO_Tools\BuildFinderPrice\update_prices.py）が作る。
 *   items: {公式ID: {n: 名前, k: e|c|p, w: {ワールド: [中央値, 件数, 月数]}, g: [[ワールド, 精錬, card1..4, 中央値, 件数, 月数]...]}}
 */
import { itemName, cardName } from "./bf-engine.js";

const SLOT_RE = /^(.*)\[(\d+)\]$/;
const unescape = (s) => { const t = document.createElement("textarea"); t.innerHTML = s; return t.value; };

export async function loadPrices() {
	try {
		const res = await fetch(new URL("./prices.json", import.meta.url), { cache: "no-cache" });
		if (!res.ok) return null;
		const data = await res.json();
		const byName = new Map();
		for (const [oid, it] of Object.entries(data.items || {})) {
			const name = unescape(it.n || "");
			const m = name.match(SLOT_RE);
			const base = m ? m[1] : name;
			if (!byName.has(base)) byName.set(base, []);
			byName.get(base).push({ oid, ...it, slot: m ? Number(m[2]) : null });
		}
		data.byName = byName;
		return data;
	} catch {
		return null;
	}
}

export function priceWorlds(prices) {
	if (!prices) return [];
	const set = new Set();
	for (const it of Object.values(prices.items || {})) for (const w of Object.keys(it.w || {})) set.add(w);
	return [...set].sort();
}

/** search() に渡す値段関数。kind: item | card | enchant */
export function priceOfFactory(prices, world) {
	if (!prices || !world) return () => null;
	const cache = new Map();
	return (kind, id) => {
		const key = kind + ":" + id;
		if (cache.has(key)) return cache.get(key);
		let v = null;
		if (kind === "item" || kind === "card") {
			const name = kind === "item" ? itemName(id) : cardName(id);
			const cands = prices.byName.get(name) || [];
			for (const c of cands) {
				const p = c.w?.[world]?.[0];
				if (p != null && (v == null || p < v)) v = p;
			}
		}
		cache.set(key, v);
		return v;
	};
}
