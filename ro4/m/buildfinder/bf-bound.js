/**
 * 組み合わせ探索の上限（枝刈り）の部品. 画面や計算本体には触らない.
 *
 * 目標ごとの重み lam（0以上）で、各目標の「足りない分 × 重み」を1つの数にまとめて比べる.
 * どの部位からも、重み付きの伸びが一番大きい候補を選んだとしても、足りない分に届かないなら、その先は探さない.
 * 重みを1つの目標だけにすれば「目標ごとの上限」、全部同じ割合にすれば「全体の近さ」になり、
 * 部位の候補から最適な重みを求めておけば、複数の目標が絡んで届かない場合も早く見切れる（双対の考え方）。
 */

/** 部位 j の候補の中で lam·U が一番大きい値（「そのまま」で0以上） */
function bestValue(list, lam) {
	let best = 0;
	const K = lam.length;
	for (const v of list) {
		let x = 0;
		for (let k = 0; k < K; k++) x += lam[k] * v.U[k];
		if (x > best) best = x;
	}
	return best;
}

/** lam での、部位 i 以降から b か所選んだときの重み付きの伸びの上限（prefix 配列を部位ごとに返す） */
export function topSums(lam, regionVariants) {
	const n = regionVariants.length;
	const best = regionVariants.map((l) => bestValue(l, lam));
	const out = [];
	for (let i = 0; i <= n; i++) {
		const arr = best.slice(i).sort((a, b) => b - a);
		const pre = new Float64Array(arr.length + 1);
		for (let j = 0; j < arr.length; j++) pre[j + 1] = pre[j] + arr[j];
		out.push(pre);
	}
	return out;
}

/**
 * b か所まで変えて全部の目標に届くか、重みの最適化で調べる（届かないと証明できたら lam と余り（負）を返す）.
 * F(lam) = (b か所の最大の伸び) - lam·need が負なら、どう選んでも届かない.
 * @param {Array<Array<{U: number[]}>>} regionVariants
 * @param {number[]} need
 * @param {number[]} scale  目標ごとの尺度（重みを揃える）
 * @param {number} b
 * @param {Float64Array[]} starts  重みの出発点
 * @returns {{lam: Float64Array, val: number}[]} 良かった順（val が小さい順）の重み
 */
export function optimizeLambda(regionVariants, need, scale, b, starts, iters = 200) {
	const K = need.length, n = regionVariants.length;
	const found = [];
	for (const start of starts) {
		let lam = Float64Array.from(start);
		let s = 0; for (let k = 0; k < K; k++) s += lam[k];
		if (!(s > 0)) continue;
		for (let k = 0; k < K; k++) lam[k] /= s;
		let best = { val: Infinity, lam: Float64Array.from(lam) };
		let eta = 0.8;
		for (let it = 0; it < iters; it++) {
			// 各部位で lam·U が最大の候補
			const arg = new Array(n), val = new Float64Array(n);
			for (let j = 0; j < n; j++) {
				let bv = 0, ba = null;
				for (const v of regionVariants[j]) {
					let x = 0;
					for (let k = 0; k < K; k++) x += lam[k] * v.U[k];
					if (x > bv) { bv = x; ba = v; }
				}
				arg[j] = ba; val[j] = bv;
			}
			const ord = Array.from({ length: n }, (_, j) => j).sort((x, y) => val[y] - val[x]).slice(0, b);
			let F = 0;
			const g = new Float64Array(K);
			for (const j of ord) { F += val[j]; if (arg[j]) for (let k = 0; k < K; k++) g[k] += arg[j].U[k]; }
			for (let k = 0; k < K; k++) { F -= lam[k] * need[k]; g[k] -= need[k]; }
			if (F < best.val) best = { val: F, lam: Float64Array.from(lam) };
			if (F < -1e-6 * (1 + Math.abs(best.val))) break; // 届かないと証明できた
			// 目標ごとの尺度で揃えた劣勾配の向きに、重みを下げる（乗法更新）
			let mx = 0;
			for (let k = 0; k < K; k++) { const x = Math.abs(g[k]) / scale[k]; if (x > mx) mx = x; }
			if (!(mx > 0)) break;
			let tot = 0;
			for (let k = 0; k < K; k++) { lam[k] *= Math.exp(-eta * (g[k] / scale[k]) / mx); tot += lam[k]; }
			if (!(tot > 0)) break;
			for (let k = 0; k < K; k++) lam[k] /= tot;
			eta *= 0.985;
		}
		found.push(best);
	}
	found.sort((a, b) => a.val - b.val);
	return found;
}
