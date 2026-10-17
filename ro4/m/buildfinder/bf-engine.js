/**
 * RO BuildFinder 探索エンジン.
 *
 * ラトリオの計算本体（calcCoreFromModel）を「正」として使い、
 *   1. 固定装備だけの状態（基準）を計算
 *   2. 空き部位の候補（装備・カード・エンチャント）を1つずつ足したときの差分を計算
 *   3. 差分の足し算で条件を満たす組み合わせを探索
 *   4. 見つかった組み合わせを実際に計算し直して確認
 * の順で装備構成を探す。
 */
import { get as registryGet } from "../../../engine/runtime/engine-registry.js";
import { ItemObjNew } from "../../../engine/equip/item.dat.js";
import { CardObjNew } from "../../../engine/equip/card.dat.js";
import { GetMaxSlot } from "../../../engine/equip/item.h.js";
import { IsMatchJobRestrict } from "../../../engine/data/mig.job.h.js";
import { g_constDataManager } from "../../../engine/runtime/global.js";
import { CONST_DATA_KIND_ENCHANT_LIST, CONST_DATA_KIND_JOB } from "../../../engine/const/EnumConstDataKind.js";
import { SkillObjNew } from "../../../engine/skill/skill.dat.js";
import { SKILL_DATA_INDEX_NAME, SKILL_DATA_INDEX_MAXLV } from "../../../engine/const/EnumSkillDataIndex.js";
import { RebuildCardSelectSubCollectEnchListData } from "../../../engine/equip/hmcard.js";
import * as R from "../../../engine/const/EnumEquipRegionId.js";
import * as K from "../../../engine/const/EnumItemKind.js";
import * as CK from "../../../engine/const/EnumCardKind.js";
import * as CR from "../../../engine/runtime/common.js";
import { BF_METRIC_BY_KEY, readMetrics } from "./bf-metrics.js";

const IDX_ID = 0, IDX_KIND = 1, IDX_SLOT = 5, IDX_NAME = 8;
const CIDX_ID = 0, CIDX_KIND = 1, CIDX_NAME = 2;

/** 探索対象の部位定義（武器は攻撃手段が変わるため対象外） */
export const BF_REGIONS = [
	{ key: "headTop", label: "頭上段", eq: R.EQUIP_REGION_ID_HEAD_TOP, kinds: [K.ITEM_KIND_HEAD_TOP], cardKinds: [CK.CARD_KIND_HEAD, CK.CARD_KIND_TOP],
		slots: [CR.CARD_REGION_ID_HEAD_TOP, CR.CARD_REGION_ID_ENCHANT_HEAD_TOP_1, CR.CARD_REGION_ID_ENCHANT_HEAD_TOP_2, CR.CARD_REGION_ID_ENCHANT_HEAD_TOP_3], refine: "head" },
	{ key: "headMid", label: "頭中段", eq: R.EQUIP_REGION_ID_HEAD_MID, kinds: [K.ITEM_KIND_HEAD_MID], cardKinds: [CK.CARD_KIND_HEAD, CK.CARD_KIND_MID],
		slots: [CR.CARD_REGION_ID_HEAD_MID, CR.CARD_REGION_ID_ENCHANT_HEAD_MID_1, CR.CARD_REGION_ID_ENCHANT_HEAD_MID_2, CR.CARD_REGION_ID_ENCHANT_HEAD_MID_3], refine: null },
	{ key: "headUnder", label: "頭下段", eq: R.EQUIP_REGION_ID_HEAD_UNDER, kinds: [K.ITEM_KIND_HEAD_UNDER], cardKinds: [CK.CARD_KIND_HEAD, CK.CARD_KIND_UNDER],
		slots: [CR.CARD_REGION_ID_HEAD_UNDER, CR.CARD_REGION_ID_ENCHANT_HEAD_UNDER_1, CR.CARD_REGION_ID_ENCHANT_HEAD_UNDER_2, CR.CARD_REGION_ID_ENCHANT_HEAD_UNDER_3], refine: null },
	{ key: "shield", label: "盾", eq: R.EQUIP_REGION_ID_SHIELD, kinds: [K.ITEM_KIND_SHIELD], cardKinds: [CK.CARD_KIND_SHIELD],
		slots: [CR.CARD_REGION_ID_SHIELD, CR.CARD_REGION_ID_ENCHANT_SHIELD_1, CR.CARD_REGION_ID_ENCHANT_SHIELD_2, CR.CARD_REGION_ID_ENCHANT_SHIELD_3], refine: "shield" },
	{ key: "body", label: "鎧", eq: R.EQUIP_REGION_ID_BODY, kinds: [K.ITEM_KIND_BODY], cardKinds: [CK.CARD_KIND_BODY],
		slots: [CR.CARD_REGION_ID_BODY, CR.CARD_REGION_ID_ENCHANT_BODY_1, CR.CARD_REGION_ID_ENCHANT_BODY_2, CR.CARD_REGION_ID_ENCHANT_BODY_3], refine: "body" },
	{ key: "shoulder", label: "肩", eq: R.EQUIP_REGION_ID_SHOULDER, kinds: [K.ITEM_KIND_SHOULDER], cardKinds: [CK.CARD_KIND_SHOULDER],
		slots: [CR.CARD_REGION_ID_SHOULDER, CR.CARD_REGION_ID_ENCHANT_SHOULDER_1, CR.CARD_REGION_ID_ENCHANT_SHOULDER_2, CR.CARD_REGION_ID_ENCHANT_SHOULDER_3], refine: "shoulder" },
	{ key: "shoes", label: "靴", eq: R.EQUIP_REGION_ID_SHOES, kinds: [K.ITEM_KIND_FOOT], cardKinds: [CK.CARD_KIND_FOOT],
		slots: [CR.CARD_REGION_ID_SHOES, CR.CARD_REGION_ID_ENCHANT_SHOES_1, CR.CARD_REGION_ID_ENCHANT_SHOES_2, CR.CARD_REGION_ID_ENCHANT_SHOES_3], refine: "shoes" },
	{ key: "acc1", label: "アクセ(右)", eq: R.EQUIP_REGION_ID_ACCESSORY_1, kinds: [K.ITEM_KIND_ACCESSORY, K.ITEM_KIND_ACCESSORY_ON1], cardKinds: [CK.CARD_KIND_ACCESSORY, CK.CARD_KIND_ACCESSORY_ON1],
		slots: [CR.CARD_REGION_ID_ACCESSORY_1, CR.CARD_REGION_ID_ENCHANT_ACCESSORY_1_1, CR.CARD_REGION_ID_ENCHANT_ACCESSORY_1_2, CR.CARD_REGION_ID_ENCHANT_ACCESSORY_1_3], refine: null },
	{ key: "acc2", label: "アクセ(左)", eq: R.EQUIP_REGION_ID_ACCESSORY_2, kinds: [K.ITEM_KIND_ACCESSORY, K.ITEM_KIND_ACCESSORY_ON2], cardKinds: [CK.CARD_KIND_ACCESSORY, CK.CARD_KIND_ACCESSORY_ON2],
		slots: [CR.CARD_REGION_ID_ACCESSORY_2, CR.CARD_REGION_ID_ENCHANT_ACCESSORY_2_1, CR.CARD_REGION_ID_ENCHANT_ACCESSORY_2_2, CR.CARD_REGION_ID_ENCHANT_ACCESSORY_2_3], refine: null },
];

export function itemName(id) { return ItemObjNew[id]?.[IDX_NAME] ?? ""; }
export function cardName(id) { return CardObjNew[id]?.[CIDX_NAME] ?? ""; }
export function itemSlotCount(id) { return GetMaxSlot(ItemObjNew[id]?.[IDX_SLOT] ?? 0); }

/** 現在の画面の入力からモデルを作る（固定装備・ステータス・支援などすべて） */
export function modelFromScreen() {
	return registryGet("extractModelFromDom")();
}

function cloneModel(m) {
	return structuredClone(m);
}

/** モデルを計算し、指標を読み取る。withBattle: スキルの詠唱・CTも出す（戦闘計算まで行うので遅い） */
export function evalModel(model, withBattle = false) {
	if (withBattle) {
		const b = registryGet("calcFromModel")(model);
		return readMetrics(b, b);
	}
	const r = registryGet("calcCoreFromModel")(model);
	return readMetrics(r);
}

/** 職業の攻撃スキル一覧 [[skillId, 名前, 最大Lv], ...] */
export function attackSkillsOf(jobId) {
	const job = g_constDataManager.GetDataObject(CONST_DATA_KIND_JOB, jobId);
	const ids = job?.GetAttackSkillIdArray?.() ?? [];
	return ids.map((id) => [id, SkillObjNew[id]?.[SKILL_DATA_INDEX_NAME] ?? String(id), Number(SkillObjNew[id]?.[SKILL_DATA_INDEX_MAXLV] ?? 1)]).filter(([, n]) => n);
}

/** その部位が空き（装備なし）か */
export function isRegionEmpty(model, region) {
	const id = model.equip[region.eq];
	if (!id) return true;
	const name = itemName(id);
	return /装備なし$|^\(?なし\)?$/.test(name) || name === "";
}

/** エンチャントの候補（スロットごと）を取得する。戻り値: [[cardId...], [cardId...], ...]（4スロット分） */
export function enchantOptionsOf(itemId) {
	const mgr = g_constDataManager.GetDataManger(CONST_DATA_KIND_ENCHANT_LIST);
	const ids = mgr.GetEnchListIdArrayByItemId(itemId);
	let all = [[], [], [], []];
	for (const id of ids) {
		const a = RebuildCardSelectSubCollectEnchListData(id, all);
		for (let s = 0; s < a.length && s < 4; s++) all[s] = all[s].concat(a[s]);
	}
	return all.map((slot) => {
		const set = new Set();
		for (const e of slot) if (e && e[1] > 0) set.add(e[1]);
		return [...set];
	});
}

/** 部位ごとの装備候補 */
export function itemCandidatesOf(region, jobId) {
	const out = [];
	for (const x of ItemObjNew) {
		if (!x) continue;
		if (!region.kinds.includes(x[IDX_KIND])) continue;
		if (!IsMatchJobRestrict(x[IDX_ID], jobId)) continue;
		out.push(x[IDX_ID]);
	}
	return out;
}

/** 部位ごとのカード候補 */
export function cardCandidatesOf(region) {
	const out = [];
	for (const c of CardObjNew) {
		if (!c) continue;
		if (region.cardKinds.includes(c[CIDX_KIND])) out.push(c[CIDX_ID]);
	}
	return out;
}

/** 全カード・エンチャントの名前一覧（条件「含めたいエンチャ・カード」用） */
export function allCardNames() {
	const out = [];
	for (const c of CardObjNew) {
		if (!c || !c[CIDX_NAME]) continue;
		if (c[CIDX_KIND] === CK.CARD_KIND_SET) continue;
		out.push([c[CIDX_ID], c[CIDX_NAME]]);
	}
	return out;
}

/**
 * 探索本体. 今の装備（画面の入力）を出発点に、部位ごとに「そのまま」「カード・エンチャだけ変える」「装備を入れ替える」を選んで
 * 条件を満たす構成を探す。
 * @param {object} opt
 *   conds: [{metric, target}] 目標。metric は BF_METRICS のキー（dir=1 なら target 以上、-1 なら target 以下）、または "card:<id>"（そのカード・エンチャを1つ以上含む）
 *   skill: {id, lv} スキル系の指標を使うときのスキル
 *   locked: [regionKey...] 固定（装備もカード・エンチャも変えない）部位
 *   keepItem: [regionKey...] 装備は外さず、空き枠や変えたい枠のカード・エンチャだけ変えてよい部位
 *   ngItems: [itemId...] 検索結果に出さない装備
 *   ngCards: [cardId...] 検索結果に出さないカード・エンチャ
 *   refine: 入れ替える装備の精錬値（null なら今の部位の精錬値）
 *   useCards: カードも探すか
 *   maxResults: 表示件数
 *   onProgress(text, ratio): 進捗
 *   shouldStop(): true で中断
 *   priceOf(kind, id): 値段（なければ null）
 */
export async function search(opt) {
	const { conds, locked = [], keepItem = [], ngItems = [], ngCards = [], refine = null, useCards = true, maxResults = 30, onProgress = () => {}, shouldStop = () => false, priceOf = () => null, skill = null } = opt;
	const base = modelFromScreen();
	if (skill) base.attackMethod = { skillId: skill.id, sourceType: 0, skillLv: skill.lv, optionValueArray: [] };
	const jobId = base.status.jobId;
	const regions = BF_REGIONS.filter((r) => !locked.includes(r.key));
	const ngItemSet = new Set(ngItems.map(Number));
	const ngCardSet = new Set(ngCards.map(Number));
	const itemCands = (r) => keepItem.includes(r.key) ? [] : itemCandidatesOf(r, jobId).filter((id) => !ngItemSet.has(id));
	const cardCands = (r) => cardCandidatesOf(r).filter((id) => !ngCardSet.has(id));
	const enchOpts = (id) => enchantOptionsOf(id).map((a) => a.filter((c) => !ngCardSet.has(c)));

	const metricConds = conds.filter((c) => !String(c.metric).startsWith("card:"));
	const cardConds = conds.filter((c) => String(c.metric).startsWith("card:")).map((c) => Number(String(c.metric).slice(5)));
	const mkeys = metricConds.map((c) => c.metric);
	const dirs = mkeys.map((k) => BF_METRIC_BY_KEY[k].dir);
	const withBattle = mkeys.some((k) => BF_METRIC_BY_KEY[k].battle);
	const evalM = (m) => evalModel(m, withBattle);
	const meets = (val) => metricConds.every((c, i) => dirs[i] * (val[c.metric] - c.target) >= -1e-9);

	const baseVal = evalM(cloneModel(base));
	const need = mkeys.map((k, i) => dirs[i] * (metricConds[i].target - baseVal[k]));
	const baseHits = new Set(cardConds.filter((cid) => base.card.includes(cid)));

	let lastYield = performance.now();
	const tick = async () => {
		if (performance.now() - lastYield > 40) {
			await new Promise((res) => setTimeout(res, 0));
			lastYield = performance.now();
		}
		if (shouldStop()) throw new BfStopped();
	};
	const vecFrom = (v, ref) => mkeys.map((k, i) => dirs[i] * (v[k] - ref[k]));
	const relevant = (d) => d.some((x, i) => x > 1e-9 && need[i] > 0);
	const zero = () => mkeys.map(() => 0);

	const totalWork = regions.reduce((a, r) => a + itemCands(r).length + (useCards ? cardCands(r).length : 0), 0) || 1;
	let done = 0;
	const regionVariants = [];

	for (const r of regions) {
		const curItem = isRegionEmpty(base, r) ? 0 : base.equip[r.eq];
		const curCards = r.slots.map((s) => base.card[s] || 0);
		const curRefine = r.refine ? base.defPlus[r.refine] : 0;
		const newRefine = refine == null ? curRefine : refine;
		const lostHits = new Set(curCards.filter((c) => cardConds.includes(c)));

		// 部位を空にした状態（入れ替え時のカード・エンチャの差分の基準）
		const cleared = cloneModel(base);
		cleared.equip[r.eq] = 0;
		for (const s of r.slots) cleared.card[s] = 0;
		const clearedVal = evalM(cleared);
		const slotDeltaCache = new Map();
		const slotDelta = (slot, cid) => {
			const key = slot + ":" + cid;
			if (!slotDeltaCache.has(key)) {
				const m = cloneModel(cleared);
				m.card[slot] = cid;
				slotDeltaCache.set(key, vecFrom(evalM(m), clearedVal));
			}
			return slotDeltaCache.get(key);
		};

		// カード候補（差分は空の部位に入れたときのもの）
		const cardOpts = [];
		if (useCards) {
			for (const cid of cardCands(r)) {
				await tick();
				done++;
				const d = slotDelta(r.slots[0], cid);
				const hit = cardConds.includes(cid);
				if (relevant(d) || hit) cardOpts.push({ id: cid, d, hit });
			}
		}

		const variants = [];
		// a) そのまま
		variants.push({ region: r, keep: true, itemId: curItem, cards: [], d: zero(), hits: new Set(), price: 0, count: 0, changed: 0 });

		// b) 今の装備のまま、空き・変更したい枠のカード・エンチャだけ変える
		if (curItem) {
			const ench = enchOpts(curItem);
			const slotChoices = [];
			slotChoices[0] = itemSlotCount(curItem) > 0 ? cardOpts : [];
			for (let s = 1; s < 4; s++) slotChoices[s] = [];
			for (let s = 1; s < 4; s++) {
				for (const cid of ench[s] || []) {
					if (cid === curCards[s]) continue;
					await tick();
					const m = cloneModel(base);
					m.card[r.slots[s]] = cid;
					const d = vecFrom(evalM(m), baseVal);
					const hit = cardConds.includes(cid);
					if (relevant(d) || hit) slotChoices[s].push({ id: cid, d, hit });
				}
			}
			// カード枠: 今のカードを外して入れ替えるときの差分
			if (slotChoices[0].length) {
				const m0 = cloneModel(base);
				m0.card[r.slots[0]] = 0;
				const v0 = evalM(m0);
				const removeD = vecFrom(v0, baseVal);
				slotChoices[0] = slotChoices[0].filter((o) => o.id !== curCards[0]).map((o) => ({ ...o, d: o.d.map((x, i) => x + removeD[i]) }));
			}
			for (const v of expandSlots(r, curItem, zero(), slotChoices, priceOf, need, 0)) {
				if (!v.cards.length) continue;
				const hits = new Set(v.hits);
				for (const [slot, cid] of v.cards) { const s = r.slots.indexOf(slot); if (lostHits.has(curCards[s])) hits.delete(curCards[s]); }
				variants.push({ region: r, keep: true, itemId: curItem, cards: v.cards, d: v.d, hits, price: v.price, count: v.cards.length, changed: 1 });
			}
			await tick();
		}

		// c) 装備を入れ替える
		for (const iid of itemCands(r)) {
			await tick();
			done++;
			if (done % 20 === 0) onProgress(`${r.label}：装備を確認中（${itemName(iid)}）`, done / totalWork);
			if (iid === curItem) continue;
			const m = cloneModel(cleared);
			m.equip[r.eq] = iid;
			if (r.refine) m.defPlus[r.refine] = newRefine;
			const d = vecFrom(evalM(m), baseVal);

			const ench = enchOpts(iid);
			const slotChoices = [itemSlotCount(iid) > 0 ? cardOpts : []];
			for (let s = 1; s < 4; s++) {
				const opts = [];
				for (const cid of ench[s] || []) {
					await tick();
					const ed = slotDelta(r.slots[s], cid);
					const hit = cardConds.includes(cid);
					if (relevant(ed) || hit) opts.push({ id: cid, d: ed, hit });
				}
				slotChoices.push(opts);
			}
			if (!relevant(d) && !slotChoices.some((o) => o.length)) continue;
			const itemPrice = priceOf("item", iid) ?? 0;
			for (const v of expandSlots(r, iid, d, slotChoices, priceOf, need, itemPrice)) {
				variants.push({ region: r, keep: false, itemId: iid, cards: v.cards, d: v.d, hits: v.hits, price: v.price, count: 1 + v.cards.length, changed: 1, lost: lostHits });
			}
		}
		onProgress(`${r.label}：確認しました`, done / totalWork);
		regionVariants.push(paretoPrune(variants, need).slice(0, 300));
	}

	// ---- 組み合わせ探索（深さ優先＋上限による枝刈り） ----
	onProgress("組み合わせを探しています", 1);
	const n = regionVariants.length;
	const maxRest = [];
	let acc = zero();
	for (let i = n - 1; i >= 0; i--) {
		const best = mkeys.map((_, k) => Math.max(...regionVariants[i].map((v) => v.d[k])));
		acc = acc.map((x, k) => x + best[k]);
		maxRest[i] = acc;
	}
	maxRest[n] = zero();
	const hitRest = [];
	let hacc = new Set();
	for (let i = n - 1; i >= 0; i--) {
		for (const v of regionVariants[i]) for (const h of v.hits) hacc.add(h);
		hitRest[i] = new Set(hacc);
	}
	hitRest[n] = new Set();

	const found = [];
	const limit = maxResults * 20;
	const pick = [];
	let nodes = 0;
	const dfs = async (i, sum, hits) => {
		if (++nodes % 2000 === 0) await tick();
		if (found.length >= limit) return;
		for (let k = 0; k < mkeys.length; k++) if (sum[k] + maxRest[i][k] < need[k] - 1e-9) return;
		for (const h of cardConds) if (!hits.has(h) && !hitRest[i].has(h)) return;
		if (i === n) {
			found.push({ picks: pick.slice(), sum: sum.slice() });
			return;
		}
		for (const v of regionVariants[i]) {
			pick.push(v);
			let nh = hits;
			if (v.changed && !v.keep) { nh = new Set(hits); for (const h of v.lost || []) nh.delete(h); }
			if (v.hits.size) { nh = new Set(nh); for (const h of v.hits) nh.add(h); }
			await dfs(i + 1, sum.map((x, k) => x + v.d[k]), nh);
			pick.pop();
			if (found.length >= limit) return;
		}
	};
	await dfs(0, zero(), baseHits);

	// ---- 実計算で確認 ----
	const costOf = (f) => f.picks.reduce((a, v) => a + v.price, 0);
	const changesOf = (f) => f.picks.reduce((a, v) => a + v.changed, 0);
	found.sort((a, b) => (changesOf(a) - changesOf(b)) || (costOf(a) - costOf(b)));
	const results = [];
	const seen = new Set();
	for (const f of found) {
		if (results.length >= maxResults) break;
		await tick();
		const m = cloneModel(base);
		for (const v of f.picks) {
			if (!v.changed) continue;
			if (!v.keep) {
				m.equip[v.region.eq] = v.itemId;
				for (const s of v.region.slots) m.card[s] = 0;
				if (v.region.refine) m.defPlus[v.region.refine] = refine == null ? base.defPlus[v.region.refine] : refine;
			}
			for (const [slot, cid] of v.cards) m.card[slot] = cid;
		}
		const sig = JSON.stringify([m.equip, m.card]);
		if (seen.has(sig)) continue;
		seen.add(sig);
		const val = evalM(m);
		if (!meets(val)) continue;
		if (!cardConds.every((cid) => m.card.includes(cid))) continue;
		results.push({ picks: f.picks.filter((v) => v.changed), values: val, price: costOf(f), changes: changesOf(f), model: m });
		onProgress(`確認中：${results.length}件見つかりました`, 1);
	}
	return { results, baseVal, base, candidates: found.length };
}

/** 部位の4枠（カード＋エンチャ3枠）の選び方を展開する（劣るものは途中で捨てる） */
function expandSlots(region, itemId, d0, slotChoices, priceOf, need, price0) {
	let partial = [{ cards: [], d: d0.slice(), hits: new Set(), price: price0 }];
	for (let s = 0; s < slotChoices.length; s++) {
		const opts = slotChoices[s] || [];
		if (!opts.length) continue;
		const next = [];
		for (const pv of partial) {
			next.push(pv);
			for (const o of opts) {
				const hits = new Set(pv.hits);
				if (o.hit) hits.add(o.id);
				next.push({ cards: [...pv.cards, [region.slots[s], o.id]], d: pv.d.map((x, i) => x + o.d[i]), hits, price: pv.price + (priceOf(s === 0 ? "card" : "enchant", o.id) ?? 0) });
			}
		}
		partial = paretoPrune(next, need);
	}
	return partial;
}

export class BfStopped extends Error {}

/** 条件に関係する指標だけで比べ、他より全面的に劣る組を捨てる（値段・個数も比べる） */
function paretoPrune(list, need) {
	const idx = need.map((n, i) => i).filter((i) => need[i] > 0);
	const cap = (v, i) => Math.min(v.d[i], need[i]);
	const sorted = list.slice().sort((a, b) => (a.price - b.price) || ((a.count ?? a.cards?.length ?? 0) - (b.count ?? b.cards?.length ?? 0)));
	const kept = [];
	outer: for (const v of sorted) {
		for (const k of kept) {
			if (k.price > v.price) continue;
			const kc = k.count ?? k.cards.length, vc = v.count ?? v.cards.length;
			if (kc > vc) continue;
			if ((k.changed ?? 0) > (v.changed ?? 0)) continue;
			let dominated = true, strict = k.price < v.price || kc < vc || (k.changed ?? 0) < (v.changed ?? 0);
			for (const i of idx) {
				if (cap(k, i) < cap(v, i) - 1e-9) { dominated = false; break; }
				if (cap(k, i) > cap(v, i) + 1e-9) strict = true;
			}
			if (dominated) for (const h of v.hits) if (!k.hits.has(h)) { dominated = false; break; }
			if (dominated && k.hits.size > v.hits.size) strict = true;
			// 全く同じ条件のものは別の候補として残す（並べて比べられるように）
			if (dominated && strict) continue outer;
		}
		kept.push(v);
	}
	return kept;
}
