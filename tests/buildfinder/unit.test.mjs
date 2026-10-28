// 装備シミュ（BuildFinder）の部品の単体テスト。依存なしで動く: node --test tests/buildfinder/unit.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { aspdOf, AUX_NEED, solveFill, finishDef } from "../../ro4/m/buildfinder/bf-fill.js";
import { paretoPrune, within } from "../../ro4/m/buildfinder/bf-prune.js";

test("ASPD の式は 前+(200-前)×ASPD%/100+固定", () => {
	assert.equal(aspdOf(150, 10, 3), 150 + 50 * 0.1 + 3);
});

test("within: 中身が全部含まれるか（並べ替え済み）", () => {
	assert.ok(within(["a", "c"], ["a", "b", "c"]));
	assert.ok(!within(["a", "d"], ["a", "b", "c"]));
});

test("solveFill: 足りない分に届く最少の枠の使い方を返す", () => {
	const need = [10, 10], W = [0.1, 0.1];
	const mk = (opts) => finishDef({ id: 0, opts: [{ id: 0, d: [0, 0], price: 0, sets: [] }, ...opts.map(([id, d, price]) => ({ id, d, price, sets: [] }))] }, need, W, []);
	const def = mk([[1, [10, 0], 5], [2, [0, 10], 7]]);
	const groups = [{ def, slot: 0 }, { def, slot: 1 }];
	const sols = solveFill(groups, [10, 10], need, { want: 3 });
	assert.ok(sols.length >= 1 && sols[0].used === 2);
	assert.deepEqual(solveFill(groups, [30, 0], need, { want: 3 }).length, 0);
});

test("paretoPrune: ASPD の内訳だけが上回る装備でも、目標に届く別候補は残す", () => {
	// 目標: ASPD(raw) 10。内訳 a/p/f は補助（AUX_NEED）。どちらも目標に届き、B は内訳で上回る
	const need = [10, AUX_NEED, AUX_NEED, AUX_NEED];
	const mk = (itemId, d) => ({ itemId, d, price: 100, count: 1, changed: 1, cards: [], groups: [], selfRel: true });
	const A = mk(1, [12, 0, 10, 0]), B = mk(2, [15, 3, 10, 0]);
	const kept = paretoPrune([A, B], need);
	assert.deepEqual(kept.map((v) => v.itemId).sort(), [1, 2]);
	// 目標でも上回られ、内訳も劣る物は捨てる
	const C = mk(3, [5, 0, 5, 0]);
	assert.deepEqual(paretoPrune([A, C], need).map((v) => v.itemId), [1]);
});
