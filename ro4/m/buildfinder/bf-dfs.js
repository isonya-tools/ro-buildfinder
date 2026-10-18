/**
 * 装備の組み合わせの深さ優先探索（枝刈りつき）. 画面のスレッドと計算用 Worker の両方から使う（画面や計算本体には触らない）.
 * 部位 0..n-1 を順に決める。途中の組（prefix）から先だけを探せるので、探索を小さな仕事に分けて Worker に配れる。
 *
 * ctx（部位ごとの候補 LV と、探索の上限の準備）:
 *   n, K, need, W, scaleOf, LV[i][v]（v.d / v.U / v.P / v.price / v.changed / v.groups / v.pkg ...）, cardSets, FILL_WANT,
 *   shieldLocked, baseShield, startTwoHand, topSumP, lossFrom, failMemo（Map. Worker では Worker ごとに持つ）
 *   budget, feas, nL, LU[i][v]（重みごとの U）, topL[l][i], lneed[l]
 */
import { solveFill } from "./bf-fill.js";

const ordCache = new WeakMap();

/**
 * prefix（部位 0.. の候補の番号）から先を探す.
 * @param {number|null} cut  この深さまで来たら先へ進まず、その組を prefixes に返す（仕事を分けるとき用）
 * @param {number|null} deadline  performance.now() がこれを超えたら途中でやめる（aborted: 結果は捨てて分け直す）
 * @returns {{leaves: {idx: number[], sols: object[]}[], prefixes: number[][], nodes: number, found: boolean, aborted: boolean}}
 */
export function dfsRun(ctx, prefix, cut = null, deadline = null) {
	const { n, K, need, W, scaleOf, LV, LU, cardSets, FILL_WANT, shieldLocked, baseShield, topSumP, lossFrom, budget, feas, nL, topL, lneed } = ctx;
	const failMemo = ctx.failMemo || (ctx.failMemo = new Map());
	// 試す順（変えない物→安い順）は部位ごとに先に決めておく
	let ordAll = ordCache.get(LV);
	if (!ordAll) ordCache.set(LV, ordAll = LV.map((lv) => lv.map((_, vi) => vi).sort((a, b) => (lv[a].changed ? lv[a].price : -1) - (lv[b].changed ? lv[b].price : -1) || a - b)));
	const out = { leaves: [], prefixes: [], nodes: 0, found: false, aborted: false };
	const req = new Array(n).fill(null);
	const idx = [], pick = [];
	// 状態は深さごとの配列に持つ（進むときは次の深さに書き込み、戻るときは深さを戻すだけ）
	const SS = Array.from({ length: n + 2 }, () => new Float64Array(K)), SU = Array.from({ length: n + 2 }, () => new Float64Array(K)), SL = Array.from({ length: n + 2 }, () => new Float64Array(nL));
	const DEF = Array.from({ length: n + 2 }, () => new Float64Array(K));
	let sum = SS[0], sumU = SU[0], lsum = SL[0], twoHand = ctx.startTwoHand, changes = 0;
	const add = (i, vi) => {
		const v = LV[i][vi];
		if (v.pkgHead) for (const j of v.pkg.regions) if (j > i) req[j] = v.pkg;
		const lu = LU[i][vi], d = idx.length;
		const s0 = SS[d], u0 = SU[d], l0 = SL[d], s2 = SS[d + 1], u2 = SU[d + 1], l2 = SL[d + 1];
		for (let k = 0; k < K; k++) { s2[k] = s0[k] + v.d[k]; u2[k] = u0[k] + v.U[k]; }
		for (let l = 0; l < nL; l++) l2[l] = l0[l] + lu[l];
		if (v.region.key === "weapon") twoHand = v.twoHand;
		sum = s2; sumU = u2; lsum = l2; changes += v.changed;
		idx.push(vi); pick.push(v);
	};
	for (let i = 0; i < prefix.length; i++) add(i, prefix[i]);
	const expired = () => deadline != null && performance.now() > deadline;
	const upperP = (i, b) => { const pre = topSumP[i]; return pre[Math.min(b, pre.length - 1)]; };

	const rec = (i) => {
		if (out.aborted || (feas && out.found)) return;
		if ((++out.nodes & 255) === 0 && expired()) { out.aborted = true; return; }
		const left = budget - changes;
		if (left < 0) return;
		for (let l = 0; l < nL; l++) { const pre = topL[l][i]; if (lsum[l] + pre[left < pre.length ? left : pre.length - 1] < lneed[l] - 1e-9) return; }
		let R = 0;
		for (let k = 0; k < K; k++) if (need[k] > 0) { const df = need[k] - sumU[k]; if (df > 1e-9) R += (df < need[k] ? df : need[k]) * W[k]; }
		if (R > 1e-9 && upperP(i, left) < R - 1e-9) return;
		if (cut != null && i === cut) { out.prefixes.push(idx.slice()); return; }
		if (i === n) {
			if (changes !== budget) return;
			// 盾を固定しているのに両手武器を選んだ構成は除く
			if (twoHand && shieldLocked && baseShield) return;
			// 装備が決まったので、カード・エンチャ枠を解く
			const groups = [], musts = [];
			for (let j = 0; j < n; j++) {
				const v = pick[j];
				if (!v.changed) continue;
				const a0 = groups.length;
				for (const g of v.groups) groups.push(g);
				if (v.mustFill) musts.push([a0, groups.length]);
			}
			const D = need.map((x, k) => x - sum[k]);
			// 同じ枠の組で、足りない分がもっと少ない場合に届かなかったなら、これも届かない（届かなかった例を覚えておく）
			const sig = groups.map((g) => g.def.id).sort((a, b) => a - b).join(",") + "|" + musts.map(([a, b]) => groups.slice(a, b).map((g) => g.def.id).join(".")).join(";");
			let fails = failMemo.get(sig);
			if (fails && fails.some((f) => { for (let k = 0; k < K; k++) if (D[k] < f[k] - 1e-9) return false; return true; })) return;
			const sols = solveFill(groups, D, need, { want: feas ? 1 : FILL_WANT, musts, stop: deadline != null ? expired : null, cardSets });
			if (expired()) { out.aborted = true; return; }
			if (!sols.length && !sols.capped) {
				const f = Float64Array.from(D);
				if (!fails) failMemo.set(sig, fails = []);
				for (let q = fails.length - 1; q >= 0; q--) { let ge = true; for (let k = 0; k < K; k++) if (fails[q][k] < f[k] - 1e-9) { ge = false; break; } if (ge) fails.splice(q, 1); }
				fails.push(f);
			}
			if (sols.length) { if (feas) out.found = true; out.leaves.push({ idx: idx.slice(), sols }); }
			return;
		}
		const must = req[i];
		// まだ足りない目標に効かない入れ替えは試さない（あとの部位で下がる分は見込む）。効き目の大きい順に試す（早く見つけて早く終わるように）
		const deficit = DEF[idx.length], lossI = lossFrom[i + 1];
		for (let k = 0; k < K; k++) { const df = need[k] - sum[k] + lossI[k]; deficit[k] = df > 0 ? df : 0; }
		const lv = LV[i], order = ordAll[i];
		for (const vi of order) {
			const v = lv[vi];
			if (changes + v.changed > budget) continue;
			if (must) { if (v.pkg !== must) continue; }
			else if (v.changed && !v.pkg) {
				let g = 0;
				for (let k = 0; k < K; k++) if (deficit[k] > 1e-9 && v.U[k] > 0) g += Math.min(v.U[k], deficit[k]) / scaleOf[k];
				if (!(g > 1e-9)) continue;
			} else if (v.pkg) {
				if (!v.pkgHead) continue;
				if (v.pkg.regions.some((j) => j > i && req[j])) continue;
			}
			let th = twoHand;
			if (v.region.key === "weapon") th = v.twoHand;
			if (v.region.key === "shield" && v.usesShield && th) continue;
			// 状態を保存して進み、戻す
			const saveTwo = twoHand, saveCh = changes, d0 = idx.length;
			add(i, vi);
			rec(i + 1);
			idx.pop(); pick.pop();
			sum = SS[d0]; sumU = SU[d0]; lsum = SL[d0]; twoHand = saveTwo; changes = saveCh;
			if (v.pkgHead) for (const j of v.pkg.regions) if (j > i) req[j] = null;
			if (out.aborted || (feas && out.found)) return;
		}
	};
	rec(prefix.length);
	return out;
}

/** 仕事を1つ実行する。時間内に終わらなければ、結果は捨てて1部位細かく分けた組（sub）を返す（分ける作業も仕事をした側でやる） */
export function dfsTask(ctx, prefix, ms) {
	const r = dfsRun(ctx, prefix, null, ms ? performance.now() + ms : null);
	if (!r.aborted) return r;
	return { nodes: r.nodes, aborted: true, sub: dfsRun(ctx, prefix, prefix.length + 1, null).prefixes, leaves: [], found: false };
}
