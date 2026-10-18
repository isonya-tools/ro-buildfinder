/**
 * カード・エンチャ枠を「あとから埋める」ための部品（装備を決めてから枠を解く. モンハンの装飾品の当てはめと同じ考え方）.
 * 画面や計算本体には触らない（計算用 Worker からも使える）。
 *
 * 枠の定義 def: { id, opts: [{ id, d, price, cnt }], mx, mp }
 *   opts[0] は「そのまま（空き or 今のカードのまま）」で d は全部0。それ以外は挿す候補（値段の安い順）
 *   mx: 目標ごとの最大の伸び（0以上）, mp: 目標への近さ（目標ごとに「伸び÷足りない分」を1までで足したもの）の最大
 * 枠 g: { def, slot }  slot: 部位の枠の番号。同じ def が続く枠は入れ替えても同じなので、候補の番号が小さい順だけを試す
 */

/**
 * ASPD の内訳の目標（aspdA / aspdP / aspdF）. 条件ではなく、ASPD を本来の式で組み立てるために持ち回る値なので、
 * 足りない分（need）はとても小さい数にしておく（どの上限の計算でも「足りない」にならない）。重みの最適化からは外す
 */
export const AUX_NEED = -1e6;
export const isAux = (need, k) => need[k] < AUX_NEED / 10;
/** らとりおの ASPD の式（上限・切り捨ての前）: ASPD%を掛ける前の値 a、ASPD% p、固定増加 f */
export function aspdOf(a, p, f) { return a + (200 - a) * p / 100 + f; }
/** a・p・f それぞれの上限からの ASPD の上限（式は a ≤ 200・p ≤ 100 の範囲で a・p・f のどれにも増える） */
export function aspdUpper(a, p, f) { return aspdOf(Math.min(a, 200), Math.min(p, 100), f); }

/** 目標への近さ（正の伸びだけ、目標ごとに足りない分で頭打ち） */
export function pPlus(d, need, W) {
	let p = 0;
	for (let k = 0; k < need.length; k++) if (need[k] > 0) { const x = d[k] > 0 ? d[k] : 0; p += (x < need[k] ? x : need[k]) * W[k]; }
	return p;
}

/** def に mx / mp を付ける（セットの上乗せ分を運ぶカードは、その分も多めに見積もる） */
export function finishDef(def, need, W, cardSets = []) {
	const K = need.length;
	const mx = new Float64Array(K);
	let mp = 0;
	for (const o of def.opts) {
		const pot = Float64Array.from(o.d);
		for (const si of o.sets || []) { const c = cardSets[si].c; for (let k = 0; k < K; k++) if (c[k] > 0) pot[k] += c[k]; }
		o.pot = pot;
		for (let k = 0; k < K; k++) if (pot[k] > mx[k]) mx[k] = pot[k];
		const p = pPlus(pot, need, W);
		if (p > mp) mp = p;
	}
	def.mx = mx; def.mp = mp;
	return def;
}

/**
 * 枠を埋めて、足りない分 D を全部満たす選び方を、使う枠の少ない順に探す.
 * @param {Array<{def, slot}>} groups  埋める枠（同じ def は連続して並べる）
 * @param {number[]} D  枠で足す必要がある量（目標ごと. 0以下なら不要）
 * @param {number[]} need  目標ごとの足りない分（頭打ちと重みに使う. 0以下の目標は近さに数えない）
 * @param {object} o  want: 見つける件数の上限, musts: [[from,to],...] その範囲の枠のどれかは必ず変える, cap: 節の数の上限,
 *                    cardSets: [{members, c}] そろうと上乗せがあるカードの組（枠の候補の sets で番号を指す）
 *                    ax: ASPD を本来の式で確かめるときの準備 { iA, iP, iF, a, p, f（枠より前までの値）, T（目標） }
 * @returns {Array<{pick: number[], used: number, price: number}>}
 */
export function solveFill(groups, D, need, o = {}) {
	const { want = 3, musts = [], cap = 3e6, stop = null, cardSets = [], stats = null, ax = null } = o;
	const K = D.length, G = groups.length;
	const W = need.map((x) => (x > 0 ? 1 / x : 0));
	if (G === 0) {
		for (let k = 0; k < K; k++) if (D[k] > 1e-9) return [];
		if (ax && aspdOf(ax.a, ax.p, ax.f) < ax.T - 1e-9) return [];
		return musts.length ? [] : [{ pick: [], used: 0, price: 0 }];
	}
	// 後ろの枠 g.. から c 個の枠を使って足せる量の上限（目標ごと・全体）。これで「あと c 個の枠で届くか」を調べる
	const topK = new Array(G + 1), topP = new Array(G + 1);
	for (let g = 0; g <= G; g++) {
		topK[g] = [];
		for (let k = 0; k < K; k++) {
			const arr = [];
			for (let h = g; h < G; h++) { const v = groups[h].def.mx[k]; if (v > 0) arr.push(v); }
			arr.sort((a, b) => b - a);
			const pre = new Float64Array(arr.length + 1);
			for (let i = 0; i < arr.length; i++) pre[i + 1] = pre[i] + arr[i];
			topK[g].push(pre);
		}
		const arr = [];
		for (let h = g; h < G; h++) { const v = groups[h].def.mp; if (v > 0) arr.push(v); }
		arr.sort((a, b) => b - a);
		const pre = new Float64Array(arr.length + 1);
		for (let i = 0; i < arr.length; i++) pre[i + 1] = pre[i] + arr[i];
		topP[g] = pre;
	}
	const pre = (arr, c) => arr[c < arr.length ? c : arr.length - 1];
	// 使う枠の数の下限（全部の枠から一番効くものを選んでも届かない数）
	let uMin = 0;
	for (let k = 0; k < K; k++) {
		if (D[k] <= 1e-9) continue;
		const arr = topK[0][k];
		let c = 0;
		while (c < arr.length - 1 && arr[c] < D[k] - 1e-9) c++;
		if (arr[c] < D[k] - 1e-9) return [];
		if (c > uMin) uMin = c;
	}
	let R0 = 0;
	for (let k = 0; k < K; k++) if (need[k] > 0 && D[k] > 1e-9) R0 += Math.min(D[k], need[k]) * W[k];
	if (R0 > 1e-9) {
		const arr = topP[0];
		let c = 0;
		while (c < arr.length - 1 && arr[c] < R0 - 1e-9) c++;
		if (arr[c] < R0 - 1e-9) return [];
		if (c > uMin) uMin = c;
	}

	// 重み付きの上限: 枠ごとに lam·(挿したときの伸び) が一番大きい候補を選んだとして、あと c 個の枠で足りない分に届くか.
	// 重みを求め直す（双対の最適化）と、複数の目標が絡んで届かない場合も早く見切れる
	const optPot = groups.map((g) => g.def.opts.map((x) => x.pot));
	const gval = (lam) => {
		const v = new Float64Array(G);
		for (let g = 0; g < G; g++) {
			let best = 0;
			for (const pt of optPot[g]) { let x = 0; for (let k = 0; k < K; k++) x += lam[k] * pt[k]; if (x > best) best = x; }
			v[g] = best;
		}
		return v;
	};
	const preSuffix = (v) => {
		const out = new Array(G + 1);
		for (let g = 0; g <= G; g++) {
			const arr = []; for (let h = g; h < G; h++) if (v[h] > 0) arr.push(v[h]);
			arr.sort((a, b) => b - a);
			const pre = new Float64Array(arr.length + 1);
			for (let i = 0; i < arr.length; i++) pre[i + 1] = pre[i] + arr[i];
			out[g] = pre;
		}
		return out;
	};
	const dot = (lam, x) => { let t = 0; for (let k = 0; k < K; k++) t += lam[k] * x[k]; return t; };
	const sc = need.map((x, k) => (x > 0 ? x : 1));
	/** u 個の枠で届かないと証明できる重みを探す（見つからなければ、最も近かった重みを返す） */
	const optimize = (u, starts) => {
		let bestAll = null;
		for (const st of starts) {
			const lam = Float64Array.from(st);
			let sum = 0; for (let k = 0; k < K; k++) sum += lam[k];
			if (!(sum > 0)) continue;
			for (let k = 0; k < K; k++) lam[k] /= sum;
			for (let k = 0; k < K; k++) if (isAux(need, k)) lam[k] = 0;
			let eta = 0.8;
			for (let it = 0; it < 30; it++) {
				// 枠ごとの最大の候補
				const val = new Float64Array(G), arg = new Array(G);
				for (let g = 0; g < G; g++) {
					let best = 0, ba = null;
					for (const pt of optPot[g]) { const x = dot(lam, pt); if (x > best) { best = x; ba = pt; } }
					val[g] = best; arg[g] = ba;
				}
				const ord = Array.from({ length: G }, (_, g) => g).sort((a, b) => val[b] - val[a]).slice(0, u);
				let F = -dot(lam, D);
				const gr = new Float64Array(K);
				for (const g of ord) { F += val[g]; if (arg[g]) for (let k = 0; k < K; k++) gr[k] += arg[g][k]; }
				for (let k = 0; k < K; k++) gr[k] -= D[k];
				if (!bestAll || F < bestAll.F) bestAll = { F, lam: Float64Array.from(lam) };
				if (F < -1e-7) return bestAll;
				let mx = 0; for (let k = 0; k < K; k++) { if (isAux(need, k)) continue; const x = Math.abs(gr[k]) / sc[k]; if (x > mx) mx = x; }
				if (!(mx > 0)) break;
				let tot = 0;
				for (let k = 0; k < K; k++) { lam[k] *= Math.exp(-eta * (gr[k] / sc[k]) / mx); tot += lam[k]; }
				if (!(tot > 0)) break;
				for (let k = 0; k < K; k++) lam[k] /= tot;
				eta *= 0.93;
			}
		}
		return bestAll;
	};
	const baseStarts = [Float64Array.from(W.map((x) => x || 0)), Float64Array.from(sc, (x) => 1 / x)];
	let lamSet = [], lamPre = [], lamD = [];

	const pick = new Int32Array(G);
	const stack = Array.from({ length: G + 1 }, () => new Float64Array(K));
	const stackU = Array.from({ length: G + 1 }, () => new Float64Array(K));
	let nodes = 0;
	let out = [];
	let maxUsed = 0;
	const mustOk = () => musts.every(([a, b]) => { for (let g = a; g < b; g++) if (pick[g] > 0) return true; return false; });
	const final = (s) => {
		let tot = s;
		if (cardSets.length) {
			// 選んだカードで、セットがそろったものの上乗せ分を足す
			let present = null;
			for (let h = 0; h < G; h++) {
				if (!pick[h]) continue;
				const op = groups[h].def.opts[pick[h]];
				if (!op.sets.length) continue;
				(present ||= new Set());
				for (const si of op.sets) present.add(si);
			}
			if (present) {
				const chosen = new Set();
				for (let h = 0; h < G; h++) if (pick[h]) chosen.add(groups[h].def.opts[pick[h]].id);
				tot = Float64Array.from(s);
				for (const si of present) {
					const st = cardSets[si];
					if (st.members.every((c) => chosen.has(c))) for (let k = 0; k < K; k++) tot[k] += st.c[k];
				}
			}
		}
		for (let k = 0; k < K; k++) if (tot[k] < D[k] - 1e-9) return false;
		// ASPD は足し算ではなく本来の式で確かめる
		if (ax && aspdOf(ax.a + tot[ax.iA], ax.p + tot[ax.iP], ax.f + tot[ax.iF]) < ax.T - 1e-9) return false;
		return true;
	};
	const rec = (g, used, price) => {
		if (out.length >= want) return;
		if (++nodes > cap) return;
		if (stop && (nodes & 1023) === 0 && stop()) { nodes = cap + 1; return; }
		const s = stack[g], su = stackU[g];
		if (g === G) {
			if (used !== maxUsed) return;
			if (!final(s)) return;
			if (!mustOk()) return;
			out.push({ pick: Array.from(pick), used, price });
			return;
		}
		// あと (maxUsed - used) 個の枠を使って届く見込みがあるか（目標ごと・全体）
		const r = maxUsed - used;
		const tk = topK[g];
		for (let k = 0; k < K; k++) { const df = D[k] - su[k]; if (df > 1e-9 && pre(tk[k], r) < df - 1e-9) return; }
		let R = 0;
		for (let k = 0; k < K; k++) if (need[k] > 0) { const df = D[k] - su[k]; if (df > 1e-9) R += (df < need[k] ? df : need[k]) * W[k]; }
		if (R > 1e-9 && pre(topP[g], r) < R - 1e-9) return;
		if (ax && aspdUpper(ax.a + su[ax.iA] + pre(tk[ax.iA], r), ax.p + su[ax.iP] + pre(tk[ax.iP], r), ax.f + su[ax.iF] + pre(tk[ax.iF], r)) < ax.T - 1e-9) return;
		for (let l = 0; l < lamSet.length; l++) { const lam = lamSet[l]; let x = lamD[l]; for (let k = 0; k < K; k++) x -= lam[k] * su[k]; if (x > 1e-9 && pre(lamPre[l][g], r) < x - 1e-9) return; }
		const gr = groups[g], opts = gr.def.opts;
		const same = g > 0 && groups[g - 1].def === gr.def;
		const from = same ? pick[g - 1] : 0;
		const nx = stack[g + 1], nu = stackU[g + 1];
		for (let oi = from; oi < opts.length; oi++) {
			const u2 = used + (oi > 0 ? 1 : 0);
			if (u2 > maxUsed) break;
			const d = opts[oi].d, pt = opts[oi].pot;
			for (let k = 0; k < K; k++) { nx[k] = s[k] + d[k]; nu[k] = su[k] + pt[k]; }
			pick[g] = oi;
			rec(g + 1, u2, price + opts[oi].price);
			if (out.length >= want || nodes > cap) return;
		}
		pick[g] = 0;
	};
	// 使う枠の少ない順に（同じ数の中では安い順に）探す
	let total = 0, capped = false;
	for (let u = uMin; u <= G; u++) {
		const cert = optimize(u, baseStarts);
		if (cert && cert.F < -1e-7) continue;
		lamSet = cert ? [cert.lam] : []; lamPre = lamSet.map((lam) => preSuffix(gval(lam))); lamD = lamSet.map((lam) => dot(lam, D));
		out = []; nodes = 0; maxUsed = u; stack[0].fill(0); stackU[0].fill(0);
		rec(0, 0, 0);
		total += nodes;
		if (out.length) { if (stats) { stats.nodes += total; stats.calls++; } return out; }
		if (nodes > cap) { if (stats) stats.capped++; capped = true; break; }
	}
	if (stats) { stats.nodes += total; stats.calls++; if (total > stats.max) stats.max = total; }
	const none = [];
	none.capped = capped;
	return none;
}
