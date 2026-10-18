/**
 * 部位の候補の絞り込み（性能で負ける組を捨てる・目標への近さの上位を残す・カード/エンチャ枠の組み合わせを広げる）.
 * 画面のスレッドと計算用の Worker の両方から使う（画面や計算本体には触らない）。
 */
import { isAux } from "./bf-fill.js";

export function expandSlots(slots, d0, slotChoices, need, price0) {
	let partial = [{ cards: [], d: d0.slice(), price: price0 }];
	for (let s = 0; s < slotChoices.length; s++) {
		const opts = slotChoices[s] || [];
		if (!opts.length) continue;
		const next = [];
		for (const pv of partial) {
			next.push(pv);
			for (const o of opts) {
				next.push({ cards: [...pv.cards, [slots[s], o.id]], d: pv.d.map((x, i) => x + o.d[i]), price: pv.price + o.p });
			}
		}
		// 条件が多いと組み合わせが爆発するので、目標への近さの上位だけ残す
		// 比べる手間は件数の2乗なので、先に目標への近さの上位（目標ごとの一番手は必ず残る）に絞ってから比べる
		partial = topByProgress(paretoPrune(next.length > EXPAND_PRUNE_MAX ? topByProgress(next, need, EXPAND_PRUNE_MAX) : next, need), need, EXPAND_KEEP);
	}
	return partial;
}


/** 目標への近さ（目標ごとに「伸び÷足りない分」を1までで足したもの） */
export function progressOf(v, need) {
	let p = 0;
	for (let i = 0; i < need.length; i++) if (need[i] > 0) p += Math.min(1, Math.max(0, v.d[i]) / need[i]);
	return p;
}
const EXPAND_KEEP = 80, PRUNE_INPUT_MAX = 3000, EXPAND_PRUNE_MAX = 600;
/**
 * 目標への近さの上位 n 件（同じなら安い順）。n 件以下ならそのまま。
 * 目標が多いと、1つの目標にしか効かない物（例: 錐効果だけのヴァルキリーカースブライト）が近さで負けて落ちるので、
 * 目標ごとに一番伸びるもの（PER_GOAL_KEEP 件）は必ず残す
 */
const PER_GOAL_KEEP = 3;
export function topByProgress(list, need, n) {
	if (list.length <= n) return list;
	const keep = new Set();
	for (let i = 0; i < need.length; i++) {
		if (!(need[i] > 0)) continue;
		const best = list.filter((v) => v.d[i] > 1e-9).sort((a, b) => (Math.min(b.d[i], need[i]) - Math.min(a.d[i], need[i])) || (a.price - b.price)).slice(0, PER_GOAL_KEEP);
		for (const v of best) keep.add(v);
	}
	const rest = list.filter((v) => !keep.has(v)).map((v) => [progressOf(v, need), v]).sort((a, b) => (b[0] - a[0]) || (a[1].price - b[1].price));
	return [...keep, ...rest.slice(0, Math.max(0, n - keep.size)).map((x) => x[1])];
}

/** 部位の候補を n 件に絞る（「そのまま」は必ず残し、並びは元の安い順のまま） */
export function trimVariants(list, need, n) {
	if (list.length <= n) return list;
	const keep = new Set(topByProgress(list, need, n));
	return list.filter((v) => keep.has(v) || !v.changed);
}

/** a（並べ替え済み）の中身が全部 b（並べ替え済み）に含まれる（b は a に何か足しただけ） */
export function within(a, b) {
	let j = 0;
	for (const x of a) { while (j < b.length && b[j] < x) j++; if (b[j] !== x) return false; j++; }
	return true;
}

/** 条件に関係する指標だけで比べ、他より全面的に劣る組を捨てる（値段・個数も比べる） */
export function paretoPrune(list, need, o = {}) {
	// free: 値段・個数・中身の違いは見ず、性能で負けているものを全部捨てる（届くかどうかだけを調べるとき用）
	const free = !!o.free;
	// 比べるのは件数の2乗の手間なので、多すぎるときは先に目標への効き目の上位に絞る（値段では切らない）
	// 「そのまま（変えない）」は効き目0でも必ず残す（無いと、その部位を変えない組み合わせが作れない）
	if (list.length > PRUNE_INPUT_MAX) list = [...new Set([...list.filter((v) => !v.changed), ...topByProgress(list, need, PRUNE_INPUT_MAX)])];
	// ASPD の内訳（isAux）も比べる（ASPD は内訳のどれにも増えるので、内訳が全部上回っていれば ASPD も負けない）。内訳は頭打ちにしない
	const idx = need.map((n, i) => i).filter((i) => need[i] > 0 || isAux(need, i));
	// 比べる値（目標で頭打ちにした伸び）は先に1回だけ作っておく（比べる回数が多いので）
	const caps = new Map();
	for (const v of list) caps.set(v, Float64Array.from(idx, (i) => (need[i] > 0 ? Math.min(v.d[i], need[i]) : v.d[i])));
	const whatMemo = new Map();
	// 中身: 効果を出している物（カード・エンチャントと、装備自体に効果があるならその装備）。
	// エンチャントを付けるためだけの装備は中身に入れない（同じエンチャントなら安い装備に絞る）
	const what = (v) => {
		let w = whatMemo.get(v);
		if (w) return w;
		w = (v.cards || []).map((c) => "c" + c[1]);
		if (v.selfRel !== false && v.itemId) w.push("i" + v.itemId);
		if (v.setRefine != null) w.push("r");
		w.sort();
		whatMemo.set(v, w);
		return w;
	};

	// 枠（あとから埋めるカード・エンチャ枠）は、dominated にするほうが同じ枠を全部持っているときだけ比べる
	const gmemo = new Map();
	const gcnt = (v) => {
		let m = gmemo.get(v);
		if (!m) { m = new Map(); for (const g of v.groups || []) m.set(g.def.id, (m.get(g.def.id) || 0) + 1); gmemo.set(v, m); }
		return m;
	};
	const covers = (k, v) => {
		if (k.mustFill && !v.mustFill) return false;
		const mv = gcnt(v);
		if (!mv.size) return true;
		const mk = gcnt(k);
		for (const [id, c] of mv) if ((mk.get(id) || 0) < c) return false;
		return true;
	};

	const prog = (v) => { let x = 0; const c = caps.get(v); for (let j = 0; j < c.length; j++) if (need[idx[j]] > 0) x += c[j] / need[idx[j]]; return x; };
	const sorted = free
		? list.slice().sort((a, b) => (prog(b) - prog(a)) || (a.price - b.price))
		: list.slice().sort((a, b) => (a.price - b.price) || ((a.count ?? a.cards?.length ?? 0) - (b.count ?? b.cards?.length ?? 0)));
	const kept = [];
	outer: for (const v of sorted) {
		for (const k of kept) {
			if (!free) {
				if (k.price > v.price) continue;
				const kc = k.count ?? k.cards?.length ?? 0, vc = v.count ?? v.cards?.length ?? 0;
				if (kc > vc) continue;
			}
			if ((k.changed ?? 0) > (v.changed ?? 0)) continue;
			if (k.twoHand && !v.twoHand) continue;
			if (!covers(k, v)) continue;
			let dominated = true, better = false;
			const ck = caps.get(k), cv = caps.get(v);
			for (let j = 0; j < ck.length; j++) {
				if (ck[j] < cv[j] - 1e-9) { dominated = false; break; }
				if (ck[j] > cv[j] + 1e-9) better = true;
			}
			// 性能で負けているものは捨てる。性能が同じなら、中身が違うもの（同じ耐性に届く別のカードなど）は
			// 値段が高くても別の候補として残し、中身が同じもの・余計な物を足しただけのものは捨てる
			if (dominated && (free || better || within(what(k), what(v)))) continue outer;
		}
		kept.push(v);
	}
	return kept;
}
