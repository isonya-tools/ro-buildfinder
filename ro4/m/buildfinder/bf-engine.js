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
import { ITEM_SP_STUFF2HAND as SP_STUFF2HAND } from "../../../engine/const/EnumItemSpId.js";
import { RebuildCardSelectSubCollectEnchListData } from "../../../engine/equip/hmcard.js";
import * as R from "../../../engine/const/EnumEquipRegionId.js";
import * as K from "../../../engine/const/EnumItemKind.js";
import * as CK from "../../../engine/const/EnumCardKind.js";
import * as CR from "../../../engine/runtime/common.js";
import { readMetrics } from "./bf-metrics.js";
import { loadHard, makeRelevance, relevantItemSets } from "./bf-relevance.js";
import * as NE from "../../../engine/equip/item.dat.js";

const IDX_ID = 0, IDX_KIND = 1, IDX_SLOT = 5, IDX_NAME = 8;
const CIDX_ID = 0, CIDX_KIND = 1, CIDX_NAME = 2;

/** 探索対象の部位定義。empty: 装備なしのアイテムID、refine: 精錬値の場所 */
const armor = (key, label, eq, kinds, cardKinds, slots, refine, empty) => ({ key, label, eq, kinds, cardKinds, slots, refine, empty });
export const BF_REGIONS = [
	armor("weapon", "武器", R.EQUIP_REGION_ID_ARMS, null, [CK.CARD_KIND_ARMS],
		[CR.CARD_REGION_ID_ARMS_RIGHT_1, CR.CARD_REGION_ID_ARMS_RIGHT_2, CR.CARD_REGION_ID_ARMS_RIGHT_3, CR.CARD_REGION_ID_ARMS_RIGHT_4], "weapon", 0),
	armor("headTop", "頭上段", R.EQUIP_REGION_ID_HEAD_TOP, [K.ITEM_KIND_HEAD_TOP], [CK.CARD_KIND_HEAD, CK.CARD_KIND_TOP],
		[CR.CARD_REGION_ID_HEAD_TOP, CR.CARD_REGION_ID_ENCHANT_HEAD_TOP_1, CR.CARD_REGION_ID_ENCHANT_HEAD_TOP_2, CR.CARD_REGION_ID_ENCHANT_HEAD_TOP_3], "head", NE.ITEM_ID_NOEQUIP_HEAD_TOP),
	armor("headMid", "頭中段", R.EQUIP_REGION_ID_HEAD_MID, [K.ITEM_KIND_HEAD_MID], [CK.CARD_KIND_HEAD, CK.CARD_KIND_MID],
		[CR.CARD_REGION_ID_HEAD_MID, CR.CARD_REGION_ID_ENCHANT_HEAD_MID_1, CR.CARD_REGION_ID_ENCHANT_HEAD_MID_2, CR.CARD_REGION_ID_ENCHANT_HEAD_MID_3], null, NE.ITEM_ID_NOEQUIP_HEAD_MID),
	armor("headUnder", "頭下段", R.EQUIP_REGION_ID_HEAD_UNDER, [K.ITEM_KIND_HEAD_UNDER], [CK.CARD_KIND_HEAD, CK.CARD_KIND_UNDER],
		[CR.CARD_REGION_ID_HEAD_UNDER, CR.CARD_REGION_ID_ENCHANT_HEAD_UNDER_1, CR.CARD_REGION_ID_ENCHANT_HEAD_UNDER_2, CR.CARD_REGION_ID_ENCHANT_HEAD_UNDER_3], null, NE.ITEM_ID_NOEQUIP_HEAD_UNDER),
	armor("shield", "盾", R.EQUIP_REGION_ID_SHIELD, [K.ITEM_KIND_SHIELD], [CK.CARD_KIND_SHIELD],
		[CR.CARD_REGION_ID_SHIELD, CR.CARD_REGION_ID_ENCHANT_SHIELD_1, CR.CARD_REGION_ID_ENCHANT_SHIELD_2, CR.CARD_REGION_ID_ENCHANT_SHIELD_3], "shield", NE.ITEM_ID_NOEQUIP_SHIELD),
	armor("body", "鎧", R.EQUIP_REGION_ID_BODY, [K.ITEM_KIND_BODY], [CK.CARD_KIND_BODY],
		[CR.CARD_REGION_ID_BODY, CR.CARD_REGION_ID_ENCHANT_BODY_1, CR.CARD_REGION_ID_ENCHANT_BODY_2, CR.CARD_REGION_ID_ENCHANT_BODY_3], "body", NE.ITEM_ID_NOEQUIP_BODY),
	armor("shoulder", "肩", R.EQUIP_REGION_ID_SHOULDER, [K.ITEM_KIND_SHOULDER], [CK.CARD_KIND_SHOULDER],
		[CR.CARD_REGION_ID_SHOULDER, CR.CARD_REGION_ID_ENCHANT_SHOULDER_1, CR.CARD_REGION_ID_ENCHANT_SHOULDER_2, CR.CARD_REGION_ID_ENCHANT_SHOULDER_3], "shoulder", NE.ITEM_ID_NOEQUIP_SHOULDER),
	armor("shoes", "靴", R.EQUIP_REGION_ID_SHOES, [K.ITEM_KIND_FOOT], [CK.CARD_KIND_FOOT],
		[CR.CARD_REGION_ID_SHOES, CR.CARD_REGION_ID_ENCHANT_SHOES_1, CR.CARD_REGION_ID_ENCHANT_SHOES_2, CR.CARD_REGION_ID_ENCHANT_SHOES_3], "shoes", NE.ITEM_ID_NOEQUIP_SHOES),
	armor("acc1", "アクセ(右)", R.EQUIP_REGION_ID_ACCESSORY_1, [K.ITEM_KIND_ACCESSORY, K.ITEM_KIND_ACCESSORY_ON1], [CK.CARD_KIND_ACCESSORY, CK.CARD_KIND_ACCESSORY_ON1],
		[CR.CARD_REGION_ID_ACCESSORY_1, CR.CARD_REGION_ID_ENCHANT_ACCESSORY_1_1, CR.CARD_REGION_ID_ENCHANT_ACCESSORY_1_2, CR.CARD_REGION_ID_ENCHANT_ACCESSORY_1_3], null, NE.ITEM_ID_NOEQUIP_ACCESSORY),
	armor("acc2", "アクセ(左)", R.EQUIP_REGION_ID_ACCESSORY_2, [K.ITEM_KIND_ACCESSORY, K.ITEM_KIND_ACCESSORY_ON2], [CK.CARD_KIND_ACCESSORY, CK.CARD_KIND_ACCESSORY_ON2],
		[CR.CARD_REGION_ID_ACCESSORY_2, CR.CARD_REGION_ID_ENCHANT_ACCESSORY_2_1, CR.CARD_REGION_ID_ENCHANT_ACCESSORY_2_2, CR.CARD_REGION_ID_ENCHANT_ACCESSORY_2_3], null, NE.ITEM_ID_NOEQUIP_ACCESSORY),
];

function getRefine(m, r) { return r.refine === "weapon" ? m.weapon.atkPlus : r.refine ? m.defPlus[r.refine] : 0; }
function setRefine(m, r, v) { if (r.refine === "weapon") m.weapon.atkPlus = v; else if (r.refine) m.defPlus[r.refine] = v; }
/** 部位に装備を置く（カード・エンチャは外し、精錬値は指定値） */
function placeItem(m, r, iid, refine) {
	clearRegion(m, r);
	m.equip[r.eq] = iid;
	if (r.key === "weapon") m.weapon.type = ItemObjNew[iid][IDX_KIND];
	setRefine(m, r, refine);
}
/** 部位を空にする（装備なし・カード/エンチャなし） */
function clearRegion(m, r) {
	m.equip[r.eq] = r.empty;
	for (const s of r.slots) m.card[s] = 0;
}

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

// 計算結果の使い回し（同じ入力なら計算しない）。条件だけ変えて検索し直すときに効く
const coreCache = new Map(), skillCache = new Map();
const CACHE_MAX = 300000;
function cached(map, key, fn) {
	let v = map.get(key);
	if (v === undefined) {
		v = fn();
		if (map.size >= CACHE_MAX) map.clear();
		map.set(key, v);
	}
	return v;
}

/** 基本の指標（耐性・ASPDなど） */
export function evalModel(model) {
	return cached(coreCache, JSON.stringify(model), () => readMetrics(registryGet("calcCoreFromModel")(model)));
}

/** スキルの固定詠唱・CT（ミリ秒） */
export function skillTimes(model, skillId, lv) {
	const m = cloneModel(model);
	m.attackMethod = { skillId, sourceType: 0, skillLv: lv, optionValueArray: [] };
	return cached(skillCache, JSON.stringify(m), () => {
		const r = registryGet("calcFromModel")(m)?.activeResultArray?.[0];
		return { cf: Math.round((r?.castFixed || 0) * 1000), ct: Math.round((r?.coolTime || 0) * 1000) };
	});
}

/** 装備を外した状態（武器本体だけ残す）。スキルの短縮量の基準 */
export function nakedModel(model) {
	const m = cloneModel(model);
	for (const r of BF_REGIONS) {
		if (r.key === "weapon") { for (const s of r.slots) m.card[s] = 0; continue; }
		clearRegion(m, r);
	}
	return m;
}

/**
 * 指標をまとめて出す。skills: [{id, lv}]（固定詠唱・CTの短縮量 sk:<id>:cf / sk:<id>:ct を出す）、naked: スキルの基準時間、
 * cards: 数えるエンチャントID（card:<id>）、elms: 鎧の属性の目標（elm:<属性> が一致なら1）
 */
export function evalAll(model, skills = [], naked = {}, cards = [], elms = []) {
	const out = { ...evalModel(model) };
	for (const sk of skills) {
		const t = skillTimes(model, sk.id, sk.lv);
		const n = naked[sk.id] || t;
		out[`sk:${sk.id}:cf`] = n.cf - t.cf;
		out[`sk:${sk.id}:ct`] = n.ct - t.ct;
		out[`skraw:${sk.id}`] = t;
	}
	for (const cid of cards) out["card:" + cid] = model.card.reduce((a, c) => a + (c === cid ? 1 : 0), 0);
	for (const e of elms) out["elm:" + e] = out.bodyElm === e ? 1 : 0;
	return out;
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
	if (!id || id === region.empty) return true;
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
export function itemCandidatesOf(region, jobId, kinds = region.kinds) {
	const out = [];
	for (const x of ItemObjNew) {
		if (!x) continue;
		if (!kinds?.includes(x[IDX_KIND])) continue;
		if (/装備なし$/.test(x[IDX_NAME])) continue;
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

/** エンチャントの名前一覧（目標の「エンチャント」用） */
export function allEnchantNames() {
	const out = [];
	for (const c of CardObjNew) {
		if (!c || !c[CIDX_NAME] || c[CIDX_KIND] !== CK.CARD_KIND_ENCHANT) continue;
		out.push([c[CIDX_ID], c[CIDX_NAME]]);
	}
	return out;
}

/** エンチャントか */
export function isEnchant(cid) { return CardObjNew[cid]?.[CIDX_KIND] === CK.CARD_KIND_ENCHANT; }

/** 全カード・エンチャントの名前一覧（除外装備用） */
export function allCardNames() {
	const out = [];
	for (const c of CardObjNew) {
		if (!c || !c[CIDX_NAME]) continue;
		if (c[CIDX_KIND] === CK.CARD_KIND_SET) continue;
		out.push([c[CIDX_ID], c[CIDX_NAME]]);
	}
	return out;
}

const TWO_HAND_KINDS = new Set([K.ITEM_KIND_SWORD_2HAND, K.ITEM_KIND_SPEAR_2HAND, K.ITEM_KIND_AXE_2HAND, K.ITEM_KIND_BOW, K.ITEM_KIND_KATAR,
	K.ITEM_KIND_FUMA, K.ITEM_KIND_RIFLE, K.ITEM_KIND_SHOTGUN, K.ITEM_KIND_GATLINGGUN, K.ITEM_KIND_GRENADEGUN, K.ITEM_KIND_STUFF2HAND]);
const WEAPON_KINDS = Object.entries(K).filter(([k, v]) => /^ITEM_KIND_/.test(k) && v >= 1 && v <= 22).map(([, v]) => v);
/** 両手武器か */
export function isTwoHanded(itemId) {
	const x = ItemObjNew[itemId];
	if (!x || !itemId) return false;
	if (TWO_HAND_KINDS.has(x[IDX_KIND])) return true;
	for (let i = 11; i + 1 < x.length; i += 2) if (x[i] === SP_STUFF2HAND) return true;
	return false;
}

/**
 * 探索本体. 今の装備（画面の入力）を出発点に、部位ごとに「そのまま」「カード・エンチャだけ変える」「装備を入れ替える」を選び、
 * さらにセット効果のある組み合わせ（複数部位をまとめて入れ替える）も候補に入れて、目標を満たす構成を探す。
 * 候補は先に「目標に関係しそうなもの」だけに絞ってから実際に計算する（bf-relevance.js）。
 * @param {object} opt
 *   conds: [{key, target}] 目標（どれも target 以上で達成）。key は指標キー、"sk:<id>:cf"/"sk:<id>:ct"（スキルの固定詠唱/CTの短縮量ms）、
 *          "card:<id>"（そのエンチャントの個数）、"elm:<属性>"（鎧の属性。一致で1）
 *   skillLv: {skillId: Lv}
 *   locked: [regionKey...] 完全に固定する部位
 *   keepItem: [regionKey...] 装備は外さず、カード・エンチャだけ変えてよい部位
 *   ngItems / ngCards: 検索結果に出さない装備 / カード・エンチャ
 *   maxResults: 表示件数
 *   onProgress(text, ratio) / shouldStop() / priceOf(kind, id)
 */
export async function search(opt) {
	const { conds, skillLv = {}, locked = [], keepItem = [], ngItems = [], ngCards = [], maxResults = 30, onProgress = () => {}, shouldStop = () => false, priceOf = () => null } = opt;
	await loadHard();
	const base = modelFromScreen();
	const jobId = base.status.jobId;
	const ngItemSet = new Set(ngItems.map(Number));
	const ngCardSet = new Set(ngCards.map(Number));

	const keys = conds.map((c) => c.key);
	const skills = [...new Set(keys.filter((k) => k.startsWith("sk:")).map((k) => Number(k.split(":")[1])))].map((id) => ({ id, lv: skillLv[id] || 1 }));
	const cards = keys.filter((k) => k.startsWith("card:")).map((k) => Number(k.slice(5)));
	const elms = keys.filter((k) => k.startsWith("elm:")).map((k) => Number(k.slice(4)));
	const rel = makeRelevance(keys);
	const nakedM = nakedModel(base);
	const naked = Object.fromEntries(skills.map((sk) => [sk.id, skillTimes(nakedM, sk.id, sk.lv)]));
	const evalM = (m) => evalAll(m, skills, naked, cards, elms);
	const meets = (val) => conds.every((c) => val[c.key] - c.target >= -1e-9);

	const baseVal = evalM(base);
	const need = conds.map((c) => c.target - baseVal[c.key]);
	const baseWeapon = base.equip[R.EQUIP_REGION_ID_ARMS];

	let lastYield = performance.now();
	const tick = async () => {
		if (performance.now() - lastYield > 40) {
			await new Promise((res) => setTimeout(res, 0));
			lastYield = performance.now();
		}
		if (shouldStop()) throw new BfStopped();
	};
	const vecFrom = (v, ref) => keys.map((k) => v[k] - ref[k]);
	const relevant = (d) => d.some((x, i) => x > 1e-9 && need[i] > 0);
	const zero = () => keys.map(() => 0);

	// ---- 候補の絞り込み ----
	onProgress("目標に関係する装備を絞り込んでいます", 0);
	const regions = BF_REGIONS.filter((r) => !locked.includes(r.key));
	const kindsOf = (r) => r.key === "weapon" ? WEAPON_KINDS : r.kinds;
	const enchCache = new Map();
	const enchOf = (id) => {
		if (!enchCache.has(id)) enchCache.set(id, enchantOptionsOf(id).map((a) => a.filter((c) => !ngCardSet.has(c) && rel.card(c))));
		return enchCache.get(id);
	};
	const cardCandsOf = (r) => cardCandidatesOf(r).filter((id) => !ngCardSet.has(id) && rel.card(id));
	const itemCandsOf = (r, hasCardOpts) => {
		if (keepItem.includes(r.key)) return [];
		const all = itemCandidatesOf(r, jobId, kindsOf(r)).filter((id) => !ngItemSet.has(id));
		const out = [];
		const hosts = new Map(); // 効果は無関係でもカードを挿せる装備（スロット数ごとに一番安いもの）
		for (const id of all) {
			if (rel.item(id) || enchOf(id).some((a) => a.length)) { out.push(id); continue; }
			const n = hasCardOpts ? itemSlotCount(id) : 0;
			if (n <= 0) continue;
			const p = priceOf("item", id) ?? Infinity;
			const cur = hosts.get(n);
			if (!cur || p < cur.p) hosts.set(n, { id, p });
		}
		for (const { id } of hosts.values()) out.push(id);
		return out;
	};

	const regionCards = regions.map(cardCandsOf);
	const regionItems = regions.map((r, i) => itemCandsOf(r, regionCards[i].length > 0));
	const sets = relevantItemSets(rel);
	const totalWork = regionItems.reduce((a, l) => a + l.length, 0) + regionCards.reduce((a, l) => a + l.length, 0) + sets.length || 1;
	let done = 0;

	const regionVariants = [];
	const regionCtx = [];
	const slotChoicesFor = async (ctx, iid) => {
		const nSlot = itemSlotCount(iid);
		const ench = enchOf(iid);
		const out = [];
		for (let s = 0; s < 4; s++) {
			if (s < nSlot) { out.push(ctx.cardOpts); continue; }
			const opts = [];
			for (const cid of ench[s] || []) {
				await tick();
				const ed = ctx.slotDelta(s, cid);
				if (relevant(ed)) opts.push({ id: cid, d: ed });
			}
			out.push(opts);
		}
		return out;
	};

	for (let ri = 0; ri < regions.length; ri++) {
		const r = regions[ri];
		const curItem = isRegionEmpty(base, r) ? 0 : base.equip[r.eq];
		const curCards = r.slots.map((s) => base.card[s] || 0);
		const curRefine = getRefine(base, r);
		onProgress(`${r.label}：確認中`, done / totalWork);

		// 部位を空にした状態（入れ替え時のカード・エンチャの差分の基準）
		const cleared = cloneModel(base);
		clearRegion(cleared, r);
		const clearedVal = evalM(cleared);
		const cardDelta = new Map();
		const slotDelta = (s, cid) => {
			const key = s + ":" + cid;
			if (!cardDelta.has(key)) {
				const m = cloneModel(cleared);
				m.card[r.slots[s]] = cid;
				cardDelta.set(key, vecFrom(evalM(m), clearedVal));
			}
			return cardDelta.get(key);
		};

		// カード候補（差分は空の部位に入れたときのもの。カード枠どこに挿しても同じとみなす）
		const cardOpts = [];
		for (const cid of regionCards[ri]) {
			await tick();
			done++;
			const d = slotDelta(0, cid);
			if (relevant(d)) cardOpts.push({ id: cid, d });
		}
		const ctx = { r, cardOpts, slotDelta, keepVariants: [] };

		const variants = [];
		const twoHand0 = r.key === "weapon" && isTwoHanded(curItem);
		// a) そのまま
		variants.push({ region: r, keep: true, itemId: curItem, cards: [], d: zero(), price: 0, count: 0, changed: 0, twoHand: twoHand0, usesShield: r.key === "shield" && !!curItem });

		// b) 今の装備のまま、カード・エンチャだけ変える
		if (curItem) {
			const nSlot = itemSlotCount(curItem);
			const ench = enchOf(curItem);
			const slotChoices = [];
			for (let s = 0; s < 4; s++) {
				const opts = [];
				if (s < nSlot) {
					// 今のカードを外したときの差分を足す
					let removeD = zero();
					if (curCards[s] && cardOpts.length) {
						const m0 = cloneModel(base);
						m0.card[r.slots[s]] = 0;
						removeD = vecFrom(evalM(m0), baseVal);
					}
					for (const o of cardOpts) if (o.id !== curCards[s]) opts.push({ id: o.id, d: o.d.map((x, i) => x + removeD[i]) });
				} else {
					for (const cid of ench[s] || []) {
						if (cid === curCards[s]) continue;
						await tick();
						const m = cloneModel(base);
						m.card[r.slots[s]] = cid;
						const d = vecFrom(evalM(m), baseVal);
						if (relevant(d)) opts.push({ id: cid, d });
					}
				}
				slotChoices.push(opts);
			}
			for (const v of expandSlots(r, zero(), slotChoices, priceOf, need, 0)) {
				if (!v.cards.length) continue;
				variants.push({ region: r, keep: true, itemId: curItem, cards: v.cards, d: v.d, price: v.price, count: v.cards.length, changed: 1, twoHand: twoHand0, usesShield: variants[0].usesShield });
			}
		}
		ctx.keepVariants = variants.slice();

		// c) 装備を入れ替える
		for (const iid of regionItems[ri]) {
			await tick();
			done++;
			if (done % 10 === 0) onProgress(`${r.label}：装備を確認中（${itemName(iid)}）`, done / totalWork);
			if (iid === curItem) continue;
			const m = cloneModel(cleared);
			placeItem(m, r, iid, curRefine);
			const d = vecFrom(evalM(m), baseVal);
			const slotChoices = await slotChoicesFor(ctx, iid);
			if (!relevant(d) && !slotChoices.some((o) => o.length)) continue;
			const itemPrice = priceOf("item", iid) ?? 0;
			for (const v of expandSlots(r, d, slotChoices, priceOf, need, itemPrice)) {
				variants.push({ region: r, keep: false, itemId: iid, cards: v.cards, d: v.d, price: v.price, count: 1 + v.cards.length, changed: 1, twoHand: r.key === "weapon" && isTwoHanded(iid), usesShield: r.key === "shield" });
			}
		}
		regionVariants.push(paretoPrune(variants, need, true).slice(0, 300));
		regionCtx.push(ctx);
	}

	// ---- セット効果（複数部位をまとめて入れ替える候補） ----
	const regionIndex = new Map(regions.map((r, i) => [r.key, i]));
	const shieldLocked = !regionIndex.has("shield");
	const baseShield = !isRegionEmpty(base, BF_REGIONS.find((r) => r.key === "shield"));
	let pkgCount = 0;
	for (const S of sets) {
		await tick();
		done++;
		if (done % 10 === 0) onProgress("セット効果を確認中", done / totalWork);
		const assign = [];
		const used = new Set();
		let ok = true;
		for (const mid of S.members) {
			const x = ItemObjNew[mid];
			if (!x) { ok = false; break; }
			const eqR = BF_REGIONS.find((r) => !used.has(r.key) && base.equip[r.eq] === mid);
			if (eqR) { used.add(eqR.key); assign.push({ region: eqR, itemId: mid, already: true }); continue; }
			if (ngItemSet.has(mid) || !IsMatchJobRestrict(mid, jobId)) { ok = false; break; }
			const r = regions.find((r) => !used.has(r.key) && !keepItem.includes(r.key) && kindsOf(r)?.includes(x[IDX_KIND]));
			if (!r) { ok = false; break; }
			used.add(r.key);
			assign.push({ region: r, itemId: mid, already: false });
		}
		if (!ok || assign.every((a) => a.already)) continue;
		const wpn = assign.find((a) => a.region.key === "weapon" && !a.already);
		if (wpn && isTwoHanded(wpn.itemId) && (assign.some((a) => a.region.key === "shield") || (shieldLocked && baseShield))) continue;
		const m = cloneModel(base);
		for (const a of assign) if (!a.already) placeItem(m, a.region, a.itemId, getRefine(base, a.region));
		const d = vecFrom(evalM(m), baseVal);
		if (!relevant(d)) continue;
		const inDfs = assign.filter((a) => regionIndex.has(a.region.key)).sort((a, b) => regionIndex.get(a.region.key) - regionIndex.get(b.region.key));
		const pkg = { id: S.setIndex, src: S.src, regions: inDfs.map((a) => regionIndex.get(a.region.key)), members: S.members };
		for (let k = 0; k < inDfs.length; k++) {
			const a = inDfs[k];
			const idx = regionIndex.get(a.region.key);
			const ctx = regionCtx[idx];
			let vs;
			if (a.already) vs = ctx.keepVariants.map((v) => ({ ...v }));
			else {
				const slotChoices = await slotChoicesFor(ctx, a.itemId);
				vs = expandSlots(a.region, zero(), slotChoices, priceOf, need, priceOf("item", a.itemId) ?? 0).map((v) => ({
					region: a.region, keep: false, itemId: a.itemId, cards: v.cards, d: v.d, price: v.price, count: 1 + v.cards.length, changed: 1,
					twoHand: a.region.key === "weapon" && isTwoHanded(a.itemId), usesShield: a.region.key === "shield",
				}));
			}
			vs = paretoPrune(vs, need).slice(0, 20);
			for (const v of vs) {
				v.pkg = pkg;
				v.pkgHead = k === 0;
				if (k === 0) v.d = v.d.map((x, i) => x + d[i]);
				regionVariants[idx].push(v);
			}
		}
		pkgCount++;
	}

	// ---- 組み合わせ探索（深さ優先＋上限による枝刈り） ----
	onProgress("組み合わせを探しています", 1);
	const weaponLocked = !regionIndex.has("weapon");
	const n = regionVariants.length;
	const maxRest = [];
	let acc = zero();
	for (let i = n - 1; i >= 0; i--) {
		const best = keys.map((_, k) => Math.max(...regionVariants[i].map((v) => v.d[k])));
		acc = acc.map((x, k) => x + best[k]);
		maxRest[i] = acc;
	}
	maxRest[n] = zero();

	const found = [];
	const limit = maxResults * 20;
	const pick = [];
	const req = new Array(n).fill(null); // セットで決まっている部位
	let nodes = 0;
	const dfs = async (i, sum, twoHand) => {
		if (++nodes % 2000 === 0) await tick();
		if (found.length >= limit) return;
		for (let k = 0; k < keys.length; k++) if (sum[k] + maxRest[i][k] < need[k] - 1e-9) return;
		if (i === n) {
			// 盾を固定しているのに両手武器を選んだ構成は除く
			if (twoHand && shieldLocked && baseShield) return;
			found.push({ picks: pick.slice(), sum: sum.slice() });
			return;
		}
		const must = req[i];
		for (const v of regionVariants[i]) {
			if (must) { if (v.pkg !== must) continue; }
			else if (v.pkg) {
				if (!v.pkgHead) continue;
				if (v.pkg.regions.some((j) => j > i && req[j])) continue;
			}
			let th = twoHand;
			if (v.region.key === "weapon") th = v.twoHand;
			if (v.region.key === "shield" && v.usesShield && th) continue;
			if (v.pkgHead) for (const j of v.pkg.regions) if (j > i) req[j] = v.pkg;
			pick.push(v);
			await dfs(i + 1, sum.map((x, k) => x + v.d[k]), th);
			pick.pop();
			if (v.pkgHead) for (const j of v.pkg.regions) if (j > i) req[j] = null;
			if (found.length >= limit) return;
		}
	};
	await dfs(0, zero(), weaponLocked ? isTwoHanded(baseWeapon) : false);

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
			const r = v.region;
			if (!v.keep) placeItem(m, r, v.itemId, getRefine(base, r));
			for (const [slot, cid] of v.cards) m.card[slot] = cid;
		}
		const sig = JSON.stringify([m.equip, m.card]);
		if (seen.has(sig)) continue;
		seen.add(sig);
		const val = evalM(m);
		if (!meets(val)) continue;
		results.push({ picks: f.picks.filter((v) => v.changed), values: val, price: costOf(f), changes: changesOf(f), model: m });
		onProgress(`確認中：${results.length}件見つかりました`, 1);
	}
	return { results, baseVal, base, candidates: found.length, stats: { items: regionItems.reduce((a, l) => a + l.length, 0), cards: regionCards.reduce((a, l) => a + l.length, 0), sets: sets.length, packages: pkgCount } };
}

/** 部位の4枠（カード＋エンチャ3枠）の選び方を展開する（劣るものは途中で捨てる） */
function expandSlots(region, d0, slotChoices, priceOf, need, price0) {
	let partial = [{ cards: [], d: d0.slice(), price: price0 }];
	for (let s = 0; s < slotChoices.length; s++) {
		const opts = slotChoices[s] || [];
		if (!opts.length) continue;
		const next = [];
		for (const pv of partial) {
			next.push(pv);
			for (const o of opts) {
				next.push({ cards: [...pv.cards, [region.slots[s], o.id]], d: pv.d.map((x, i) => x + o.d[i]), price: pv.price + (priceOf("card", o.id) ?? 0) });
			}
		}
		partial = paretoPrune(next, need);
	}
	return partial;
}

export class BfStopped extends Error {}

/** 条件に関係する指標だけで比べ、他より全面的に劣る組を捨てる（値段・個数も比べる） */
function paretoPrune(list, need, keepTies = false) {
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
			if (k.twoHand && !v.twoHand) continue;
			let dominated = true, strict = k.price < v.price || kc < vc || (k.changed ?? 0) < (v.changed ?? 0);
			for (const i of idx) {
				if (cap(k, i) < cap(v, i) - 1e-9) { dominated = false; break; }
				if (cap(k, i) > cap(v, i) + 1e-9) strict = true;
			}
			// 全く同じ条件のものは別の候補として残す（並べて比べられるように）
			if (dominated && (strict || !keepTies)) continue outer;
		}
		kept.push(v);
	}
	return kept;
}
