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
import { MIG_BORDER_FLAG_ID_OVER, MIG_BORDER_FLAG_ID_EQUAL } from "../../../engine/const/EnumMigBorderFlagId.js";
import * as R from "../../../engine/const/EnumEquipRegionId.js";
import * as K from "../../../engine/const/EnumItemKind.js";
import * as CK from "../../../engine/const/EnumCardKind.js";
import * as CR from "../../../engine/runtime/common.js";
import { readMetrics } from "./bf-metrics.js";
import { loadHard, makeRelevance, relevantItemSets, isHardItem } from "./bf-relevance.js";
import * as NE from "../../../engine/equip/item.dat.js";

const IDX_ID = 0, IDX_KIND = 1, IDX_SLOT = 5, IDX_NAME = 8;
const CIDX_ID = 0, CIDX_KIND = 1, CIDX_NAME = 2;

/** 探索対象の部位定義。empty: 装備なしのアイテムID、refine: 精錬値の場所 */
const armor = (key, label, eq, kinds, cardKinds, slots, refine, empty) => ({ key, label, eq, kinds, cardKinds, slots, refine, empty });
const shadow = (key, label, rid, kinds, slots) => ({ key, label, eq: null, shadow: rid, kinds, cardKinds: [], slots: [-1, ...slots], refine: "shadow", empty: 0 });
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
	// シャドウ装備. 装備は model.shadowEquip.itemId[部位ID]、精錬値は shadowEquip.refined。
	// カードは挿せず、エンチャントは3つ（エンチャ一覧の2〜4番目の枠）。slots の先頭 -1 はカード枠が無い印
	shadow("sWeapon", "シャドウ武器", R.EQUIP_REGION_ID_SHADOW_ARMS_RIGHT, [K.ITEM_KIND_SHADOW_ARMS_RIGHT, K.ITEM_KIND_SHADOW_ARMS_1HAND, K.ITEM_KIND_SHADOW_ARMS_2HAND],
		[CR.CARD_REGION_ID_SHADOW_ARMS_RIGHT_1, CR.CARD_REGION_ID_SHADOW_ARMS_RIGHT_2, CR.CARD_REGION_ID_SHADOW_ARMS_RIGHT_3]),
	shadow("sShield", "シャドウ盾", R.EQUIP_REGION_ID_SHADOW_ARMS_LEFT, [K.ITEM_KIND_SHADOW_ARMS_LEFT, K.ITEM_KIND_SHADOW_SHIELD],
		[CR.CARD_REGION_ID_SHADOW_SHIELD_1, CR.CARD_REGION_ID_SHADOW_SHIELD_2, CR.CARD_REGION_ID_SHADOW_SHIELD_3]),
	shadow("sBody", "シャドウ鎧", R.EQUIP_REGION_ID_SHADOW_BODY, [K.ITEM_KIND_SHADOW_BODY],
		[CR.CARD_REGION_ID_SHADOW_ENCHANT_BODY_1, CR.CARD_REGION_ID_SHADOW_ENCHANT_BODY_2, CR.CARD_REGION_ID_SHADOW_ENCHANT_BODY_3]),
	shadow("sShoes", "シャドウ靴", R.EQUIP_REGION_ID_SHADOW_FOOT, [K.ITEM_KIND_SHADOW_FOOT],
		[CR.CARD_REGION_ID_SHADOW_ENCHANT_SHOES_1, CR.CARD_REGION_ID_SHADOW_ENCHANT_SHOES_2, CR.CARD_REGION_ID_SHADOW_ENCHANT_SHOES_3]),
	shadow("sAcc1", "シャドウアクセ(右)", R.EQUIP_REGION_ID_SHADOW_ACCESSORY_1, [K.ITEM_KIND_SHADOW_ACCESSORY, K.ITEM_KIND_SHADOW_ACCESSORY_ON1],
		[CR.CARD_REGION_ID_SHADOW_ENCHANT_ACCESSORY1_1, CR.CARD_REGION_ID_SHADOW_ENCHANT_ACCESSORY1_2, CR.CARD_REGION_ID_SHADOW_ENCHANT_ACCESSORY1_3]),
	shadow("sAcc2", "シャドウアクセ(左)", R.EQUIP_REGION_ID_SHADOW_ACCESSORY_2, [K.ITEM_KIND_SHADOW_ACCESSORY, K.ITEM_KIND_SHADOW_ACCESSORY_ON2],
		[CR.CARD_REGION_ID_SHADOW_ENCHANT_ACCESSORY2_1, CR.CARD_REGION_ID_SHADOW_ENCHANT_ACCESSORY2_2, CR.CARD_REGION_ID_SHADOW_ENCHANT_ACCESSORY2_3]),
];

// アクセサリーの左右（入れ替えただけの構成は同じとみなす）
const ACC_PAIR = { acc1: "acc2", sAcc1: "sAcc2" };
const ACC_SIDE = { acc2: "acc1", sAcc2: "sAcc1" };
const REGION_BY_KEY = Object.fromEntries(BF_REGIONS.map((r) => [r.key, r]));
/** 部位の装備ID（シャドウは shadowEquip から） */
export function regionItem(m, r) { return r.shadow ? (m?.shadowEquip?.itemId?.[r.shadow] || 0) : m?.equip?.[r.eq]; }
function setRegionItem(m, r, iid) {
	if (!r.shadow) { m.equip[r.eq] = iid; return; }
	m.shadowEquip ??= { itemId: [], refined: [], rndOpt: [] };
	if (m.shadowEquip.itemId[r.shadow] !== iid) (m.shadowEquip.rndOpt ??= [])[r.shadow] = [];
	m.shadowEquip.itemId[r.shadow] = iid;
}
export function getRefine(m, r) {
	if (r.refine === "shadow") return m?.shadowEquip?.refined?.[r.shadow] || 0;
	return r.refine === "weapon" ? m.weapon.atkPlus : r.refine ? m.defPlus[r.refine] : 0;
}
function setRefine(m, r, v) {
	if (r.refine === "shadow") { m.shadowEquip ??= { itemId: [], refined: [], rndOpt: [] }; m.shadowEquip.refined[r.shadow] = v; }
	else if (r.refine === "weapon") m.weapon.atkPlus = v; else if (r.refine) m.defPlus[r.refine] = v;
}
/**
 * 入れ替える装備で試す精錬値. +0 に加えて、過剰精錬で効果が変わる値（データの「精錬値◯以上」「精錬1ごと」、
 * 計算処理が精錬値を見る装備）と、エンチャントの精錬値の条件。精錬できない部位は+0だけ。
 */
const refineLevelCache = new Map();
/** codeOk(SPコード): 目標に関係する効果だけ見るときの判定（省略時は全部） */
function refineLevelsOf(r, iid, codeOk = null) {
	if (!r.refine) return [0];
	const key = r.key + ":" + iid;
	if (!codeOk && refineLevelCache.has(key)) return refineLevelCache.get(key);
	const set = new Set([0]);
	const row = ItemObjNew[iid] || [];
	for (let i = 11; i + 1 < row.length; i += 2) {
		const code = row[i];
		if (typeof code !== "number" || code === 0) break;
		if (codeOk && !codeOk(code)) continue;
		const x = code % 100000000;
		const over = Math.floor(x / 1000000);
		if (over >= 1) { set.add(over); set.add(Math.min(20, over + 1)); }
		if (Math.floor((x % 1000000) / 100000) >= 1) set.add(10);
	}
	if (isHardItem(iid)) for (const v of [7, 9, 10, 11]) set.add(v);
	for (const m of enchantDetailOf(iid)) for (const need of m.values()) if (need > 0) set.add(need);
	const out = [...set].filter((v) => v <= 20).sort((a, b) => a - b);
	if (!codeOk) refineLevelCache.set(key, out);
	return out;
}

/** 部位に装備を置く（カード・エンチャは外し、精錬値は指定値） */
function placeItem(m, r, iid, refine) {
	clearRegion(m, r);
	setRegionItem(m, r, iid);
	if (r.key === "weapon") m.weapon.type = ItemObjNew[iid][IDX_KIND];
	setRefine(m, r, refine);
}
/** 部位を空にする（装備なし・カード/エンチャなし） */
function clearRegion(m, r) {
	setRegionItem(m, r, r.empty);
	if (r.shadow) setRefine(m, r, 0);
	for (const s of r.slots) if (s >= 0) m.card[s] = 0;
}

export function itemName(id) { return ItemObjNew[id]?.[IDX_NAME] ?? ""; }
export function cardName(id) { return CardObjNew[id]?.[CIDX_NAME] ?? ""; }
export function itemSlotCount(id) { return GetMaxSlot(ItemObjNew[id]?.[IDX_SLOT] ?? 0); }

/** 現在の画面の入力からモデルを作る（固定装備・ステータス・支援などすべて） */
let buffOn = {};
/** 発動バフ（時限効果）の個別オンオフ。{時限効果ID: true}、載っていないものはオフ */
export function setBuffOn(on) { buffOn = on || {}; }
export function modelFromScreen() {
	const m = registryGet("extractModelFromDom")();
	// 設定欄（timeItemConf）は消さずに、オンオフ（timeItemConfEffective）だけ差し替える
	if (Array.isArray(m.timeItemConf)) m.timeItemConfEffective = m.timeItemConf.map((id) => id > 0 && !!buffOn[id]);
	return m;
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
	const id = regionItem(model, region);
	if (!id || id === region.empty) return true;
	const name = itemName(id);
	return /装備なし$|^\(?なし\)?$/.test(name) || name === "";
}

/**
 * エンチャントの候補（スロットごと）と、付けるのに要る精錬値. 戻り値: [Map(エンチャントID → 必要な精錬値), ...]（4スロット分）
 */
const enchDetailCache = new Map();

/**
 * 公式の強化・エンチャント情報（bf-official-ench.json、tools-bf-official.py で作成）。
 * らとりおのエンチャント一覧は、同じ名前の一覧をまとめて複数の装備に付けているため、装備によっては
 * 実際には付かないエンチャントが混ざる（例: 蜃気楼エンチャント グループ1 → イリュージョンマフラーのイミューンファイア）。
 * 公式にその装備の一覧がほぼそろって載っている（8割以上一致）のに、公式に無いエンチャントだけ外す。
 * 表記の違いで外しすぎないよう、能力値・Atk・SP などの数値だけのエンチャントは外さない。
 */
let official = null;
const normName = (s) => String(s).normalize("NFKC").replace(/\[\d+\]$/, "").replace(/\(最大\d+個\)/g, "").replace(/[<>＜＞\s]/g, "").toLowerCase();
const PLAIN_STAT = /^(atk|matk|sp|maxsp|hp|maxhp|str|agi|vit|int|dex|luk|cri|flee|hit|def|mdef|aspd|詠唱時間|special)/;
export async function loadOfficial() {
	if (official) return;
	try {
		const res = await fetch(new URL("./bf-official-ench.json", import.meta.url));
		const j = res.ok ? await res.json() : null;
		if (j) {
			const names = j.names.map(normName);
			official = { names: new Set(names), items: new Map(Object.entries(j.items).map(([k, v]) => [normName(k), new Set(v.map((i) => names[i]))])) };
		}
	} catch { /* 読めなければらとりおのデータのまま */ }
	if (!official) official = { names: new Set(), items: new Map() };
	enchDetailCache.clear();
}
/** 一覧1つぶん（スロットごとの [_, cardId, params] の配列）から、公式に無いものを外す */
function officialFilter(itemId, slots) {
	const allowed = official?.items.get(normName(itemName(itemId)));
	if (!allowed) return slots;
	const known = new Set();
	for (const slot of slots) for (const e of slot) if (e && e[1] > 0) { const n = normName(cardName(e[1])); if (official.names.has(n)) known.add(n); }
	if (!known.size) return slots;
	const hit = [...known].filter((n) => allowed.has(n)).length;
	if (hit < known.size * 0.8) return slots;
	return slots.map((slot) => slot.filter((e) => {
		if (!e || !(e[1] > 0)) return true;
		const n = normName(cardName(e[1]));
		return !official.names.has(n) || allowed.has(n) || PLAIN_STAT.test(n);
	}));
}
export function enchantDetailOf(itemId) {
	if (enchDetailCache.has(itemId)) return enchDetailCache.get(itemId);
	const mgr = g_constDataManager.GetDataManger(CONST_DATA_KIND_ENCHANT_LIST);
	const ids = mgr.GetEnchListIdArrayByItemId(itemId);
	let all = [[], [], [], []];
	for (const id of ids) {
		const a = officialFilter(itemId, RebuildCardSelectSubCollectEnchListData(id, all));
		for (let s = 0; s < a.length && s < 4; s++) all[s] = all[s].concat(a[s]);
	}
	const out = all.map((slot) => {
		const map = new Map();
		for (const e of slot) {
			if (!e || !(e[1] > 0)) continue;
			const p = e[2] || {};
			// 精錬値の条件（OVER: 以上、EQUAL: ちょうど）。条件なしは0
			const need = (p.refinedBorderFlag === MIG_BORDER_FLAG_ID_OVER || p.refinedBorderFlag === MIG_BORDER_FLAG_ID_EQUAL) ? Number(p.refinedBorderBase) || 0 : 0;
			if (!map.has(e[1]) || need < map.get(e[1])) map.set(e[1], need);
		}
		return map;
	});
	enchDetailCache.set(itemId, out);
	return out;
}
/** エンチャントの候補（スロットごと）。戻り値: [[cardId...], ...]（4スロット分） */
export function enchantOptionsOf(itemId) {
	return enchantDetailOf(itemId).map((m) => [...m.keys()]);
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
	if (region.shadow) return out; // シャドウ装備にカードは挿せない
	for (const c of CardObjNew) {
		if (!c) continue;
		// CARD_KIND_ANY（ナドヨなど）はどの部位にも挿せる
		if (region.cardKinds.includes(c[CIDX_KIND]) || c[CIDX_KIND] === CK.CARD_KIND_ANY) out.push(c[CIDX_ID]);
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
 *   lock: {regionKey: {item, refine, card, ench}} 部位ごとに固定するもの（載っていないものは自由）。
 *         カードかエンチャを固定した部位は装備も固定。精錬値だけ固定なら、入れ替える装備も今の精錬値で試す
 *   ngItems / ngCards: 検索結果に出さない装備 / カード・エンチャ
 *   maxResults: 表示件数
 *   onProgress(text, ratio) / onResults(results)（途中経過。良い順） / shouldStop() / priceOf(kind, id)
 */
export async function search(opt) {
	const { conds, skillLv = {}, lock = {}, ngItems = [], ngCards = [], maxResults = 30, onProgress: report = () => {}, onResults = () => {}, shouldStop = () => false, priceOf = () => null } = opt;
	await Promise.all([loadHard(), loadOfficial()]);
	// 全体の進み具合: 候補の確認 0〜75%、組み合わせ探し（見つけたものはその場で実計算して確かめる）75〜100%
	let phase = [0, 0.75];
	const onProgress = (text, r) => report(text, Math.min(1, phase[0] + (phase[1] - phase[0]) * Math.max(0, Math.min(1, r))));
	const base = opt.base ? cloneModel(opt.base) : modelFromScreen();
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
	// スキルの固定詠唱・CTは戦闘計算まで回すので重い（1スキルで本体の計算の1.5倍ほど）。
	// 入れ替える物がスキルの短縮に関係しないときは計算せず、ref（比べる元）の値をそのまま使う
	const skKeys = keys.filter((k) => k.startsWith("sk:"));
	const relSk = skills.length ? makeRelevance(skKeys) : null;
	const evalM = (m, ref = null) => {
		let r;
		if (ref && skills.length) {
			r = evalAll(m, [], naked, cards, elms);
			for (const k of skKeys) r[k] = ref[k];
			for (const sk of skills) r[`skraw:${sk.id}`] = ref[`skraw:${sk.id}`];
		} else r = evalAll(m, skills, naked, cards, elms);
		return r;
	};
	const skRef = (isRel, ref) => (relSk && !isRel ? ref : null);
	const meets = (val) => conds.every((c) => val[c.key] - c.target >= -1e-9);
	const coreKeys = conds.filter((c) => !c.key.startsWith("sk:"));

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
	onProgress("候補を調べています", 0);
	const L = Object.fromEntries(BF_REGIONS.map((r) => {
		const x = lock[r.key] || {};
		return [r.key, { item: !!(x.item || x.card || x.ench), refine: !!x.refine, card: !!x.card, ench: !!x.ench }];
	}));
	const keepItem = BF_REGIONS.filter((r) => L[r.key].item).map((r) => r.key);
	const regions = BF_REGIONS.filter((r) => !(L[r.key].item && L[r.key].card && L[r.key].ench));
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
	const slotChoicesFor = async (ctx, iid, lv) => {
		const nSlot = itemSlotCount(iid);
		const detail = enchantDetailOf(iid);
		const ench = enchOf(iid).map((a, s) => a.filter((cid) => (detail[s].get(cid) ?? 0) <= lv));
		const out = [];
		for (let s = 0; s < 4; s++) {
			if (ctx.r.slots[s] == null || ctx.r.slots[s] < 0) { out.push([]); continue; }
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
		const curItem = isRegionEmpty(base, r) ? 0 : regionItem(base, r);
		const curCards = r.slots.map((s) => base.card[s] || 0);
		onProgress("候補を調べています", done / totalWork);

		// 部位を空にした状態（入れ替え時のカード・エンチャの差分の基準）
		const cleared = cloneModel(base);
		clearRegion(cleared, r);
		const clearedVal = evalM(cleared);
		const clearedD = vecFrom(clearedVal, baseVal);
		const cardDelta = new Map();
		const slotDelta = (s, cid) => {
			// 効果はどの枠に挿しても同じなので、エンチャント・カードごとに1回だけ計算する
			const key = cid;
			if (!cardDelta.has(key)) {
				const m = cloneModel(cleared);
				m.card[r.slots[s]] = cid;
				cardDelta.set(key, vecFrom(evalM(m, skRef(relSk?.card(cid), clearedVal)), clearedVal));
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
			const curDetail = enchantDetailOf(curItem);
			const ench = enchOf(curItem).map((a, s) => a.filter((cid) => (curDetail[s].get(cid) ?? 0) <= getRefine(base, r)));
			const slotChoices = [];
			for (let s = 0; s < 4; s++) {
				const opts = [];
				if (r.slots[s] == null || r.slots[s] < 0 || (s < nSlot ? L[r.key].card : L[r.key].ench)) { slotChoices.push(opts); continue; }
				if (s < nSlot) {
					// 今のカードを外したときの差分を足す
					let removeD = zero();
					if (curCards[s] && cardOpts.length) {
						const m0 = cloneModel(base);
						m0.card[r.slots[s]] = 0;
						removeD = vecFrom(evalM(m0, skRef(relSk?.card(curCards[s]), baseVal)), baseVal);
					}
					for (const o of cardOpts) if (o.id !== curCards[s]) opts.push({ id: o.id, d: o.d.map((x, i) => x + removeD[i]) });
				} else {
					for (const cid of ench[s] || []) {
						if (cid === curCards[s]) continue;
						await tick();
						const m = cloneModel(base);
						m.card[r.slots[s]] = cid;
						const d = vecFrom(evalM(m, skRef(relSk?.card(cid), baseVal)), baseVal);
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
			if (done % 10 === 0) onProgress("候補を調べています", done / totalWork);
			if (iid === curItem) continue;
			// 精錬値は+0が基本。過剰精錬で目標の効果が変わるとき・エンチャントに精錬値の条件があるときだけ、その精錬値も候補にする。
			// 装備自体に目標の効果が無い（エンチャントやカード枠のために入れた）ものは計算せず、部位を空にしたときと同じとみなす
			const selfRel = rel.item(iid);
			const levels = L[r.key].refine ? [getRefine(base, r)]
				: selfRel ? refineLevelsOf(r, iid, rel.code)
				: [...new Set([0, ...enchantDetailOf(iid).flatMap((mm) => [...mm.values()])])].filter((v) => v <= 20 && r.refine || v === 0).sort((a, b) => a - b);
			let prevD = null, prevEnch = -1;
			for (const lv of levels) {
				let d = clearedD;
				if (selfRel) {
					const m = cloneModel(cleared);
					placeItem(m, r, iid, lv);
					d = vecFrom(evalM(m, skRef(relSk?.item(iid), clearedVal)), baseVal);
				}
				const slotChoices = await slotChoicesFor(ctx, iid, lv);
				const nEnch = slotChoices.reduce((a, o) => a + o.length, 0);
				if (prevD && nEnch === prevEnch && d.every((x, i) => Math.abs(x - prevD[i]) < 1e-9)) continue;
				prevD = d; prevEnch = nEnch;
				if (!relevant(d) && !slotChoices.some((o) => o.length)) continue;
				// 同じ性能なら精錬値の低い方が残るように、精錬値ぶんだけ値段を重くして比べる
				const itemPrice = (priceOf("item", iid) ?? UNKNOWN_PRICE) + lv;
				for (const v of expandSlots(r, d, slotChoices, priceOf, need, itemPrice)) {
					variants.push({ region: r, keep: false, itemId: iid, refine: lv, selfRel, cards: v.cards, d: v.d, price: v.price, count: 1 + v.cards.length, changed: 1, twoHand: r.key === "weapon" && isTwoHanded(iid), usesShield: r.key === "shield" });
				}
			}
		}
		regionVariants.push(trimVariants(paretoPrune(variants, need), need, 300));
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
		if (done % 10 === 0) onProgress("候補を調べています", done / totalWork);
		const assign = [];
		const used = new Set();
		let ok = true;
		for (const mid of S.members) {
			const x = ItemObjNew[mid];
			if (!x) { ok = false; break; }
			const eqR = BF_REGIONS.find((r) => !used.has(r.key) && regionItem(base, r) === mid);
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
		// セットのメンバーも+0から。効果が出なければ、各メンバーを候補の中で一番高い精錬値にして確かめる
		let d = null;
		for (const top of [false, true]) {
			const m = cloneModel(base);
			for (const a of assign) {
				if (a.already) continue;
				const lvs = L[a.region.key].refine ? [getRefine(base, a.region)] : refineLevelsOf(a.region, a.itemId);
				a.refine = top ? lvs[lvs.length - 1] : lvs[0];
				placeItem(m, a.region, a.itemId, a.refine);
			}
			d = vecFrom(evalM(m), baseVal);
			if (relevant(d)) break;
			if (!assign.some((a) => !a.already && refineLevelsOf(a.region, a.itemId).length > 1)) break;
		}
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
				const slotChoices = await slotChoicesFor(ctx, a.itemId, a.refine);
				vs = expandSlots(a.region, zero(), slotChoices, priceOf, need, priceOf("item", a.itemId) ?? UNKNOWN_PRICE).map((v) => ({
					region: a.region, keep: false, itemId: a.itemId, refine: a.refine, cards: v.cards, d: v.d, price: v.price, count: 1 + v.cards.length, changed: 1,
					twoHand: a.region.key === "weapon" && isTwoHanded(a.itemId), usesShield: a.region.key === "shield",
				}));
			}
			vs = trimVariants(paretoPrune(vs, need), need, 20);
			for (const v of vs) {
				v.pkg = pkg;
				v.pkgHead = k === 0;
				if (k === 0) v.d = v.d.map((x, i) => x + d[i]);
				regionVariants[idx].push(v);
			}
		}
		pkgCount++;
	}

	// ---- 組み合わせ探索 ----
	// 変える部位の数が少ない順（0か所→1か所→…）に探し、その数の中では深さ優先＋上限による枝刈り。
	// 結果は「変更が少ない順→安い順」なので、ある数で表示件数がそろったら、それより多い数は探さない
	phase = [0.75, 1];
	onProgress("組み合わせを探しています", 0);
	const weaponLocked = !regionIndex.has("weapon");
	const n = regionVariants.length;
	// 部位ごとの、目標ごとの一番大きい伸び
	const bestOf = regionVariants.map((list) => keys.map((_, k) => Math.max(0, ...list.map((v) => v.d[k]))));
	// topSum[i][k][b]: 部位 i 以降から b か所選んだときの伸びの上限
	const topSum = [];
	for (let i = 0; i <= n; i++) {
		topSum[i] = keys.map((_, k) => {
			const arr = bestOf.slice(i).map((x) => x[k]).sort((x, y) => y - x);
			const pre = [0];
			for (const x of arr) pre.push(pre[pre.length - 1] + x);
			return pre;
		});
	}
	const upper = (i, k, b) => { const pre = topSum[i][k]; return pre[Math.min(b, pre.length - 1)]; };
	// 全部の部位で一番伸びるものを選んでも届かない条件（足し算の見込み）。結果が0件のときに知らせる
	const unreachable = conds.filter((c, k) => upper(0, k, n) < need[k] - 1e-9).map((c) => c.label || c.key);

	// 見つけた組み合わせは、その場で実計算で確かめて結果に入れる（onResults で途中経過を返す）
	const costOf = (f) => f.picks.reduce((a, v) => a + v.price, 0);
	const changesOf = (f) => f.picks.reduce((a, v) => a + v.changed, 0);
	const order = (a, b) => (a.changes - b.changes) || (a.cost - b.cost);
	const results = [];
	const seen = new Set();
	let foundCount = 0;
	let lastEmit = 0;
	const emit = (force) => {
		if (!force && performance.now() - lastEmit < 500) return;
		lastEmit = performance.now();
		onResults(results.slice(), { base, baseVal });
	};
	const verify = (picks) => {
		const f = { picks, changes: changesOf({ picks }), cost: costOf({ picks }) };
		const m = cloneModel(base);
		for (const v of picks) {
			if (!v.changed) continue;
			const r = v.region;
			if (!v.keep) placeItem(m, r, v.itemId, v.refine ?? 0);
			for (const [slot, cid] of v.cards) m.card[slot] = cid;
		}
		// 同じ部位の中でエンチャントの並び順だけ違うもの・アクセサリーの左右が入れ替わっただけのものは同じ構成とみなす
		const partOf = (r) => JSON.stringify([regionItem(m, r) || 0, getRefine(m, r), ...r.slots.map((s) => m.card[s] || 0).sort()]);
		const part = BF_REGIONS.filter((r) => !ACC_PAIR[r.key] && !ACC_SIDE[r.key]).map(partOf);
		for (const [a, b] of Object.entries(ACC_PAIR)) part.push([partOf(REGION_BY_KEY[a]), partOf(REGION_BY_KEY[b])].sort().join("/"));
		const sig = part.join("|");
		if (seen.has(sig)) return;
		seen.add(sig);
		// 既に見つかった構成に物を足しただけのものは出さない
		const toks = picks.filter((v) => v.changed).flatMap((v) => [...(v.keep ? [] : [`${v.region.key}:i${v.itemId}:${v.refine ?? 0}`]), ...v.cards.map(([, cid]) => `${ACC_SIDE[v.region.key] || v.region.key}:c${cid}`)]).sort();
		if (results.some((x) => within(x.toks, toks))) return;
		// まず本体の計算だけで、スキル以外の条件を満たすか確かめる（スキルの計算は重いので後回し）
		if (skills.length) {
			const core = evalAll(m, [], naked, cards, elms);
			if (!coreKeys.every((c) => core[c.key] - c.target >= -1e-9)) return;
		}
		const val = evalM(m);
		if (!meets(val)) return;
		for (let i = results.length - 1; i >= 0; i--) if (within(toks, results[i].toks)) results.splice(i, 1);
		const changed = picks.filter((v) => v.changed).map((v) => ({ ...v }));
		let price = 0, unknown = 0;
		for (const v of changed) {
			const pp = pickPrice(v, priceOf);
			v.finalPrice = pp.price;
			v.priceUnknown = pp.unknown;
			price += pp.price;
			unknown += pp.unknown;
		}
		results.push({ toks, picks: changed, values: val, price, priceUnknown: unknown, changes: f.changes, cost: f.cost, model: m });
		results.sort(order);
		if (results.length > maxResults) results.length = maxResults;
		emit(false);
	};

	const pick = [];
	const req = new Array(n).fill(null); // セットで決まっている部位
	let nodes = 0;
	let budget = 0, levelLeaves = 0;
	// 足し算の見込みでは届くのに実計算では届かない構成が続くときに、探し続けないための上限
	const levelLimit = maxResults * 50, totalLimit = maxResults * 80;
	const dfs = async (i, sum, twoHand, changes, cost) => {
		if (++nodes % 2000 === 0) {
			await tick();
			onProgress(results.length ? `組み合わせを探しています（${results.length}件）` : "組み合わせを探しています", Math.min(0.95, (budget + 0.5) / (n + 1)));
		}
		// 表示件数だけ見つかったら、その場で探すのをやめる
		if (results.length >= maxResults || levelLeaves >= levelLimit || foundCount >= totalLimit) return;
		const left = budget - changes;
		if (left < 0) return;
		for (let k = 0; k < keys.length; k++) if (sum[k] + upper(i, k, left) < need[k] - 1e-9) return;
		if (i === n) {
			if (changes !== budget) return;
			// 盾を固定しているのに両手武器を選んだ構成は除く
			if (twoHand && shieldLocked && baseShield) return;
			foundCount++; levelLeaves++;
			await tick();
			verify(pick.slice());
			return;
		}
		const must = req[i];
		for (const v of regionVariants[i]) {
			if (must) { if (v.pkg !== must) continue; }
			else if (v.pkg) {
				if (!v.pkgHead) continue;
				if (v.pkg.regions.some((j) => j > i && req[j])) continue;
			}
			if (changes + v.changed > budget) continue;
			let th = twoHand;
			if (v.region.key === "weapon") th = v.twoHand;
			if (v.region.key === "shield" && v.usesShield && th) continue;
			if (v.pkgHead) for (const j of v.pkg.regions) if (j > i) req[j] = v.pkg;
			pick.push(v);
			await dfs(i + 1, sum.map((x, k) => x + v.d[k]), th, changes + v.changed, cost + v.price);
			pick.pop();
			if (v.pkgHead) for (const j of v.pkg.regions) if (j > i) req[j] = null;
			if (results.length >= maxResults || levelLeaves >= levelLimit || foundCount >= totalLimit) return;
		}
	};
	for (budget = 0; budget <= n; budget++) {
		levelLeaves = 0;
		await dfs(0, zero(), weaponLocked ? isTwoHanded(baseWeapon) : false, 0, 0);
		if (results.length >= maxResults || foundCount >= totalLimit) break;
	}

	emit(true);
	return { results, baseVal, base, candidates: foundCount, stats: { unreachable, items: regionItems.reduce((a, l) => a + l.length, 0), cards: regionCards.reduce((a, l) => a + l.length, 0), sets: sets.length, packages: pkgCount } };
}

/**
 * 結果1部位ぶんの値段. 入れ替える装備は、選んだエンチャントが付いた取引の値段（無ければ装備だけの値段）。
 * カードは1枚ずつの値段を足す。今の装備に付けるエンチャントは値段に入れない。
 * @returns {{price: number, unknown: number}} unknown: 値段が分からなかった物の数
 */
function pickPrice(v, priceOf) {
	let price = 0, unknown = 0;
	const ench = v.cards.filter(([, cid]) => isEnchant(cid)).map(([, cid]) => cid);
	if (!v.keep) {
		// 精錬値・エンチャントが合う取引の値段。精錬なし・エンチャなしなら装備だけの値段
		let p = (ench.length || v.refine) ? priceOf("itemEnch", v.itemId, ench, v.refine || 0) : null;
		if (p == null && !v.refine) p = priceOf("item", v.itemId);
		if (p == null && ench.length) {
			// そのエンチャントの付いた取引が無いときは、装備（その精錬値以上）の値段だけ入れて、エンチャ分は不明にする
			const p2 = v.refine ? priceOf("itemEnch", v.itemId, [], v.refine) : priceOf("item", v.itemId);
			if (p2 != null) price += p2;
			unknown++;
		} else if (p == null) unknown++;
		else price += p;
	}
	for (const [, cid] of v.cards) {
		if (isEnchant(cid)) continue;
		const p = priceOf("card", cid);
		if (p == null) unknown++; else price += p;
	}
	return { price, unknown };
}

/** 部位の4枠（カード＋エンチャ3枠）の選び方を展開する（劣るものは途中で捨てる） */
/** 値段が分からない物は、並べるときに値段の分かる物より後ろにする */
const UNKNOWN_PRICE = 1e12;
function expandSlots(region, d0, slotChoices, priceOf, need, price0) {
	let partial = [{ cards: [], d: d0.slice(), price: price0 }];
	for (let s = 0; s < slotChoices.length; s++) {
		const opts = slotChoices[s] || [];
		if (!opts.length) continue;
		const next = [];
		for (const pv of partial) {
			next.push(pv);
			for (const o of opts) {
				next.push({ cards: [...pv.cards, [region.slots[s], o.id]], d: pv.d.map((x, i) => x + o.d[i]), price: pv.price + (isEnchant(o.id) ? 0 : priceOf("card", o.id) ?? UNKNOWN_PRICE) });
			}
		}
		// 条件が多いと組み合わせが爆発するので、目標への近さの上位だけ残す
		partial = topByProgress(paretoPrune(next, need), need, EXPAND_KEEP);
	}
	return partial;
}

export class BfStopped extends Error {}

/** 目標への近さ（目標ごとに「伸び÷足りない分」を1までで足したもの） */
function progressOf(v, need) {
	let p = 0;
	for (let i = 0; i < need.length; i++) if (need[i] > 0) p += Math.min(1, Math.max(0, v.d[i]) / need[i]);
	return p;
}
const EXPAND_KEEP = 80, PRUNE_INPUT_MAX = 3000;
/**
 * 目標への近さの上位 n 件（同じなら安い順）。n 件以下ならそのまま。
 * 目標が多いと、1つの目標にしか効かない物（例: 錐効果だけのヴァルキリーカースブライト）が近さで負けて落ちるので、
 * 目標ごとに一番伸びるもの（PER_GOAL_KEEP 件）は必ず残す
 */
const PER_GOAL_KEEP = 3;
function topByProgress(list, need, n) {
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
function trimVariants(list, need, n) {
	if (list.length <= n) return list;
	const keep = new Set(topByProgress(list, need, n));
	return list.filter((v) => keep.has(v) || !v.changed);
}

/** a（並べ替え済み）の中身が全部 b（並べ替え済み）に含まれる（b は a に何か足しただけ） */
function within(a, b) {
	let j = 0;
	for (const x of a) { while (j < b.length && b[j] < x) j++; if (b[j] !== x) return false; j++; }
	return true;
}

/** 条件に関係する指標だけで比べ、他より全面的に劣る組を捨てる（値段・個数も比べる） */
function paretoPrune(list, need) {
	// 比べるのは件数の2乗の手間なので、多すぎるときは先に目標への近さの上位に絞る（安いものも少し残す）
	if (list.length > PRUNE_INPUT_MAX) {
		const cheap = list.slice().sort((a, b) => a.price - b.price).slice(0, 300);
		list = [...new Set([...cheap, ...topByProgress(list, need, PRUNE_INPUT_MAX - 300)])];
	}
	const idx = need.map((n, i) => i).filter((i) => need[i] > 0);
	const cap = (v, i) => Math.min(v.d[i], need[i]);
	// 中身: 効果を出している物（カード・エンチャントと、装備自体に効果があるならその装備）。
	// エンチャントを付けるためだけの装備は中身に入れない（同じエンチャントなら安い装備に絞る）
	const what = (v) => {
		const w = (v.cards || []).map((c) => "c" + c[1]);
		if (v.selfRel !== false && v.itemId) w.push("i" + v.itemId);
		return w.sort();
	};

	const sorted = list.slice().sort((a, b) => (a.price - b.price) || ((a.count ?? a.cards?.length ?? 0) - (b.count ?? b.cards?.length ?? 0)));
	const kept = [];
	outer: for (const v of sorted) {
		for (const k of kept) {
			if (k.price > v.price) continue;
			const kc = k.count ?? k.cards.length, vc = v.count ?? v.cards.length;
			if (kc > vc) continue;
			if ((k.changed ?? 0) > (v.changed ?? 0)) continue;
			if (k.twoHand && !v.twoHand) continue;
			let dominated = true, better = false;
			for (const i of idx) {
				if (cap(k, i) < cap(v, i) - 1e-9) { dominated = false; break; }
				if (cap(k, i) > cap(v, i) + 1e-9) better = true;
			}
			// 性能で負けているものは捨てる。性能が同じなら、中身が違うもの（同じ耐性に届く別のカードなど）は
			// 値段が高くても別の候補として残し、中身が同じもの・余計な物を足しただけのものは捨てる
			if (dominated && (better || within(what(k), what(v)))) continue outer;
		}
		kept.push(v);
	}
	return kept;
}
