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
import { readMetrics, BF_METRICS, ELM_NAMES } from "./bf-metrics.js";
import { loadHard, makeRelevance, relevantItemSets, isHardItem, isHardCard, inSameSet } from "./bf-relevance.js";
import { CARD_DATA_INDEX_SPBEGIN } from "../../../engine/const/EnumCardDataIndex.js";
import * as NE from "../../../engine/equip/item.dat.js";
import { n_Enekyori, set_n_Enekyori } from "../../../engine/runtime/ro4-state.js";
import { n_Skill1SW } from "../../../engine/ui/BuffJobSpecificSelf.js";
import { n_Skill4SW } from "../../../engine/ui/BuffGuildAndGospel.js";
import { n_Skill7SW } from "../../../engine/ui/BuffItemAndFood.js";
import { n_Skill8SW } from "../../../engine/ui/BuffOtherCategory.js";
import { n_A_PassSkill, n_A_PassSkill4, n_A_PassSkill7, n_A_PassSkill8 } from "../../../engine/skill/skillstate.js";
import * as pool from "./bf-pool.js";
import { paretoPrune, within } from "./bf-prune.js";
import { pPlus, finishDef, solveFill, AUX_NEED, aspdOf, aspdUpper } from "./bf-fill.js";
import { topSums, optimizeLambda, reduceByU } from "./bf-bound.js";
import { dfsTask, packBase } from "./bf-dfs.js";
import { w_SE } from "../../../engine/equip/itemset.dat.js";

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
/** 超越段階（★）。武器と、頭上段・盾・鎧・肩・靴だけ */
export function getTrans(m, r) {
	if (r.refine === "weapon") return m?.weapon?.transcendence | 0;
	return r.refine && r.refine !== "shadow" ? m?.defTranscendence?.[r.refine] | 0 : 0;
}
function setTrans(m, r, v) {
	if (r.refine === "weapon") { if (m.weapon) m.weapon.transcendence = v; }
	else if (r.refine && r.refine !== "shadow") { m.defTranscendence ??= {}; m.defTranscendence[r.refine] = v; }
}
/** 精錬値の表示（超越していれば「★1 +10」） */
export function refineLabel(m, r) {
	const t = getTrans(m, r);
	return (t ? `★${t} ` : "") + "+" + getRefine(m, r);
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
/** 精錬値の上限（それより上は超越★で表す） */
const MAX_REFINE = 10;
const MAX_TRANS = 4;
/** 精錬値を探すときの候補: +0 と +4〜+10 だけ（+1〜+3は探さない）。超越は +10 を +0 に戻して★を1つ付けるので、+10の次は★1の+0。精錬値を固定しないときは今の精錬値以上と、超越した状態（今の★+1）の+0〜+10を候補にする */
const SEARCH_REFINES = [0, 4, 5, 6, 7, 8, 9, 10];
/** 精錬値の高さの順番（同じ効果なら低い方を残すための重み） */
const refineIndex = (t, lv) => t * 11 + lv;
function refineStepsFrom(t, lv) {
	const out = SEARCH_REFINES.filter((v) => v > lv).map((v) => ({ lv: v, t }));
	if (t < MAX_TRANS) for (const v of SEARCH_REFINES) out.push({ lv: v, t: t + 1 });
	return out;
}
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
		if (over >= 1 && over <= MAX_REFINE) { set.add(over); set.add(Math.min(MAX_REFINE, over + 1)); }
		if (Math.floor((x % 1000000) / 100000) >= 1) set.add(10);
	}
	if (isHardItem(iid)) for (const v of [7, 9, 10]) set.add(v);
	for (const m of enchantDetailOf(iid)) for (const need of m.values()) if (need > 0) set.add(need);
	// +1〜+3は探さない（+0と+4〜+10だけ。どの装備も共通）
	const out = [...set].filter((v) => v <= MAX_REFINE && (v === 0 || v >= 4)).sort((a, b) => a - b);
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
/** 部位を空にしたモデル（固定装備の「外す」用） */
export function withoutRegion(model, r) {
	const m = cloneModel(model);
	clearRegion(m, r);
	return m;
}
/** 部位を空にする（装備なし・カード/エンチャなし・精錬値0。武器は種類も素手に） */
function clearRegion(m, r) {
	setRegionItem(m, r, r.empty);
	if (r.refine) { setRefine(m, r, 0); setTrans(m, r, 0); }
	if (r.key === "weapon") m.weapon.type = 0;
	for (const s of r.slots) if (s >= 0) m.card[s] = 0;
}

/**
 * 付ける装備・精錬値で効果が変わるかもしれないカード・エンチャントか
 * （計算処理がIDを直接見ている・効果に精錬値の条件がある（+1以上のとき）・その装備と同じセット効果のメンバー）
 */
const refineCondMemo = new Map();
function hasRefineCond(cid) {
	let v = refineCondMemo.get(cid);
	if (v !== undefined) return v;
	v = false;
	const d = CardObjNew[cid];
	for (let i = 0; !v && d && d[CARD_DATA_INDEX_SPBEGIN + i] != 0 && d[CARD_DATA_INDEX_SPBEGIN + i] != null; i += 2) {
		// ＳＰ定義の 10万の位〜1000万の位が精錬値の条件（精錬値が上がる度・精錬値以上）
		const raw = d[CARD_DATA_INDEX_SPBEGIN + i];
		const low = typeof raw === "bigint" ? Number(raw % 100000000n) : raw % 100000000;
		if (low >= 100000) v = true;
	}
	refineCondMemo.set(cid, v);
	return v;
}
export function hostDependent(cid, iid, lv) {
	// カードは数が多く、計算処理が直接見るもの（hard）まで装備ごとに計算すると重すぎるので、エンチャントだけ見る
	return (isHardCard(cid) && isEnchant(cid)) || (lv > 0 && hasRefineCond(cid)) || inSameSet("c" + cid, "i" + iid);
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
const CACHE_MAX = 60000; // キーはモデル全体のJSON（大きい）なので、多く持つとメモリが足りなくなる
function cached(map, key, fn) {
	let v = map.get(key);
	if (v === undefined) {
		v = fn();
		if (map.size >= CACHE_MAX) map.clear();
		map.set(key, v);
	}
	return v;
}

/** モデルに入っていないが計算に効く画面側の状態（支援欄の開閉・閉じた欄に残った値・遠距離かどうか） */
function screenState() {
	return { n_Enekyori, n_Skill1SW, n_Skill4SW, n_Skill7SW, n_Skill8SW,
		n_A_PassSkill: [...n_A_PassSkill], n_A_PassSkill4: [...n_A_PassSkill4], n_A_PassSkill7: [...n_A_PassSkill7], n_A_PassSkill8: [...n_A_PassSkill8] };
}
/** 基本の指標（耐性・ASPDなど）。使い回しは画面側の状態も同じときだけ */
export function evalModel(model) {
	return cached(coreCache, JSON.stringify(screenState()) + JSON.stringify(model), () => readMetrics(registryGet("calcCoreFromModel")(model)));
}

/** スキルの固定詠唱・CT（ミリ秒） */
export function skillTimes(model, skillId, lv) {
	const m = cloneModel(model);
	m.attackMethod = { skillId, sourceType: 0, skillLv: lv, optionValueArray: [] };
	return cached(skillCache, JSON.stringify(screenState()) + JSON.stringify(m), () => {
		// 戦闘計算は遠距離かどうか（n_Enekyori）をそのスキルの値に書き換えるので、画面の値に戻しておく
		const ene = n_Enekyori;
		try {
			const r = registryGet("calcFromModel")(m)?.activeResultArray?.[0];
			return { cf: Math.round((r?.castFixed || 0) * 1000), ct: Math.round((r?.coolTime || 0) * 1000) };
		} finally { set_n_Enekyori(ene); }
	});
}

// ---- 別スレッド（Web Worker）での計算 ----
// 検索中は計算を Worker の束に渡して並列に回す（CPUのコア数ぶん速くなる）。Worker が使えないときはこの画面のスレッドで計算する
let usePool = false, leak = null, leakKey = "";
const inflight = new Map();
/** 計算結果の使い回しつきで、Worker か画面のスレッドで計算する */
function cachedAsync(map, key, type, model, local) {
	const v = map.get(key);
	if (v !== undefined) return v;
	const fk = type + key;
	if (inflight.has(fk)) return inflight.get(fk);
	const done = (r) => { inflight.delete(fk); if (map.size >= CACHE_MAX) map.clear(); map.set(key, r); return r; };
	let p;
	if (usePool) {
		const again = (e) => (e instanceof pool.WorkerCrash ? pool.run(type, model) : Promise.reject(e)); // 落ちた Worker の分は別の Worker で1回やり直す
		p = pool.run(type, model).catch(again).then(done, (e) => {
			inflight.delete(fk);
			if (e instanceof pool.CancelError) throw new BfStopped();
			// Worker で計算できなかったものは、以後この画面のスレッドで計算する
			usePool = false;
			return done(local());
		});
	// この画面のスレッドで計算するときは、1回ごとに画面へ順番を返す（続けて計算すると、その間ずっと画面が止まる）
	} else p = new Promise((res) => setTimeout(res, 0)).then(() => done(local()));
	inflight.set(fk, p);
	return p;
}
function evalModelAsync(model) {
	const key = leakKey + JSON.stringify(model);
	return cachedAsync(coreCache, key, "core", model, () => { if (leak) set_n_Enekyori(leak.n_Enekyori); return readMetrics(registryGet("calcCoreFromModel")(model)); });
}
function skillTimesAsync(model, skillId, lv) {
	const m = cloneModel(model);
	m.attackMethod = { skillId, sourceType: 0, skillLv: lv, optionValueArray: [] };
	return cachedAsync(skillCache, leakKey + JSON.stringify(m), "skill", m, () => {
		try {
			const r = registryGet("calcFromModel")(m)?.activeResultArray?.[0];
			return { cf: Math.round((r?.castFixed || 0) * 1000), ct: Math.round((r?.coolTime || 0) * 1000) };
		} finally { if (leak) set_n_Enekyori(leak.n_Enekyori); }
	});
}
async function evalAllAsync(model, skills = [], naked = {}, cards = [], elms = []) {
	const [core, ...times] = await Promise.all([evalModelAsync(model), ...skills.map((sk) => skillTimesAsync(model, sk.id, sk.lv))]);
	const out = { ...core };
	skills.forEach((sk, i) => {
		const t = times[i];
		const n = naked[sk.id] || t;
		out[`sk:${sk.id}:cf`] = n.cf - t.cf;
		out[`sk:${sk.id}:ct`] = n.ct - t.ct;
		out[`skraw:${sk.id}`] = t;
	});
	for (const cid of cards) out["card:" + cid] = model.card.reduce((a, c) => a + (c === cid ? 1 : 0), 0);
	for (const e of elms) out["elm:" + e] = out.bodyElm === e ? 1 : 0;
	return out;
}
/**
 * 「固定装備」: 画面で付けている装備（精錬値・カード・エンチャント込み）は固定し、空いているカード・エンチャント枠と
 * 何も付けていない部位だけを探す。シャドウ装備は探さない（常に今のまま）
 */
export function fixedLock(model, keepEmpty = {}, searchRefine = {}) {
	const lock = {};
	for (const r of BF_REGIONS) {
		if (r.shadow) lock[r.key] = { item: true, refine: true, card: true, ench: true };
		else if (!isRegionEmpty(model, r)) lock[r.key] = { item: true, refine: !searchRefine[r.key], card: true, ench: true, fill: !keepEmpty[r.key] };
	}
	return lock;
}
/** 検索を止めたときに、Worker に渡して待っている計算を取り消す */
export function cancelPending() { pool.cancelAll(); }
/** list の各要素に fn を同時に conc 個まで走らせ、結果を元の並びで返す */
async function pmap(list, fn, conc) {
	const out = new Array(list.length);
	let next = 0;
	// どれかが失敗（止める・エラー）したら、残りは始めない
	const runOne = async () => {
		while (next < list.length) {
			const i = next++;
			try { out[i] = await fn(list[i], i); } catch (e) { next = list.length; throw e; }
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(conc, list.length)) }, runOne));
	return out;
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
 * エンチャント・カードを目標にしたとき、同じ意味の指標があればそれに置き換えるための調べ物.
 * 装備なしの状態にそれ1枚だけ付けて、変わる指標が1つだけなら（例: 毒属性付与(鎧)・アルギオペ → 鎧の属性が毒、石化耐性50% → 石化耐性+50）、
 * その指標と1枚あたりの増え方を返す。複数の指標が変わる・指標に出ない効果のものは null（そのカード自体を目標にする）
 */
export function goalEquivalent(model, cid) {
	const kind = CardObjNew[cid]?.[CIDX_KIND];
	if (kind == null) return null;
	const reg = isEnchant(cid) ? BF_REGIONS.find((r) => r.key === "headTop") : (BF_REGIONS.find((r) => !r.shadow && r.cardKinds.includes(kind)) || BF_REGIONS.find((r) => r.key === "headTop"));
	const slot = reg.slots[isEnchant(cid) ? 1 : 0];
	if (slot == null || slot < 0) return null;
	const naked = nakedModel(model);
	const m = cloneModel(naked);
	m.card[slot] = cid;
	const v0 = evalModel(naked), v1 = evalModel(m);
	const changed = BF_METRICS.filter((mt) => !mt.hidden && Math.abs((v1[mt.key] ?? 0) - (v0[mt.key] ?? 0)) > 1e-9);
	if (changed.length !== 1) return null;
	const mt = changed[0];
	if (mt.kind === "elm") return { key: "elm:" + v1[mt.key], perUnit: 1, elm: true, label: mt.label + "が" + (ELM_NAMES[v1[mt.key]] ?? "") };
	const d = v1[mt.key] - v0[mt.key];
	return d > 0 ? { key: mt.key, perUnit: d, label: mt.label } : null;
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
	return /装備なし$|^\(?なし\)?$/.test(name) || name === "" || name === "素手";
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
/**
 * 除外リスト（bf-exclude.json、スプレッドシートのチェックから tools-bf-exclude.mjs で作成）。
 * もう使わない弱い装備・カード・エンチャントで、検索の候補に最初から入れない
 */
let exclude = null;
async function loadExclude() {
	if (exclude) return;
	try {
		const res = await fetch(new URL("./bf-exclude.json", import.meta.url));
		const j = res.ok ? await res.json() : null;
		if (j) exclude = { items: new Set(j.items), cards: new Set(j.cards) };
	} catch { /* 読めなければ除外なし */ }
	if (!exclude) exclude = { items: new Set(), cards: new Set() };
}

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
	const { conds, skillLv = {}, lock = {}, ngItems = [], ngCards = [], maxResults = 30, onProgress: report = () => {}, onActivity = () => {}, onResults = () => {}, shouldStop = () => false, priceOf = () => null } = opt;
	await Promise.all([loadHard(), loadOfficial(), loadExclude()]);
	// 読み込み中に止められていたら、ここで終える（共有の状態を書き換えない）
	if (shouldStop()) throw new BfStopped();
	// 全体の進み具合: 候補の確認 0〜75%、組み合わせ探し（見つけたものはその場で実計算して確かめる）75〜100%
	let phase = [0, 0.75];
	const onProgress = (text, r) => report(text, Math.min(1, phase[0] + (phase[1] - phase[0]) * Math.max(0, Math.min(1, r))));
	const base = opt.base ? cloneModel(opt.base) : modelFromScreen();
	// 装備を外した部位に残ったカード・エンチャントも、らとりおの計算では効いてしまうので外しておく
	for (const r of BF_REGIONS) if (!r.shadow && isRegionEmpty(base, r)) for (const s of r.slots) if (s >= 0) base.card[s] = 0;
	const jobId = base.status.jobId;
	const ngItemSet = new Set(ngItems.map(Number));
	const ngCardSet = new Set(ngCards.map(Number));
	// 除外リストの物は候補にしない。ただし今の構成で装備しているもの（自分で付けたもの）はそのまま使う
	{
		const wornItems = new Set(BF_REGIONS.map((r) => regionItem(base, r)));
		const wornCards = new Set(base.card);
		let ni = 0, nc = 0;
		for (const id of exclude.items) if (!wornItems.has(id) && !ngItemSet.has(id)) { ngItemSet.add(id); ni++; }
		for (const id of exclude.cards) if (!wornCards.has(id) && !ngCardSet.has(id)) { ngCardSet.add(id); nc++; }
		if (ni || nc) onActivity(`除外リストの装備 ${ni} 件・カードとエンチャント ${nc} 件は候補にしません（今付けている物は除く）`, -2);
	}

	let keys = conds.map((c) => c.key);
	const skills = [...new Set(keys.filter((k) => k.startsWith("sk:")).map((k) => Number(k.split(":")[1])))].map((id) => ({ id, lv: skillLv[id] || 1 }));
	const cards = keys.filter((k) => k.startsWith("card:")).map((k) => Number(k.slice(5)));
	const elms = keys.filter((k) => k.startsWith("elm:")).map((k) => Number(k.slice(4)));
	const rel = makeRelevance(keys);
	// 計算は Worker の束で並列に回す。最初に基準の構成で画面のスレッドの計算と一致するか確かめ、合わなければ使わない
	// モデルに入っていないが計算に効く画面側の状態（支援欄の開閉など）。Worker 側にも同じ値を入れる
	leak = screenState();
	// 計算結果の使い回しは、この状態が同じときだけ（キーの頭に付ける）
	leakKey = JSON.stringify(leak);
	usePool = false;
	pool.retry();
	const baseLocal = evalModel(base);
	set_n_Enekyori(leak.n_Enekyori);
	if (pool.available()) {
		pool.setState(leak);
		try {
			const v = await pool.run("core", base);
			const diff = Object.keys(baseLocal).filter((k) => !(Math.abs((v[k] ?? 0) - baseLocal[k]) < 1e-6));
			usePool = !diff.length;
			// 計算が画面側と合わないときは、指標の計算だけ画面のスレッドで行う（組み合わせの探索は計算本体を使わないので、Worker のまま並列にできる）
			if (!usePool) onActivity(`Worker の計算結果が画面側と合いません（${diff.slice(0, 6).map((k) => `${k}: 画面 ${baseLocal[k]} / Worker ${v[k]}`).join("、")}）。指標の計算は画面のスレッドで行います`, -2);
		} catch (e) {
			// 止めるボタンで取り消されたときは Worker を止めない（次の検索でまた使う）
			if (e instanceof pool.CancelError || shouldStop()) throw new BfStopped();
			pool.disable();
			onActivity(`別スレッド（Worker）で計算できませんでした（${e?.message || e}）。この検索はこの画面のスレッドだけで計算します`, -2);
		}
	}
	if (shouldStop()) throw new BfStopped();
	const CONC = usePool ? pool.poolSize() * 4 : 1;
	const nakedM = nakedModel(base);
	const naked = Object.fromEntries(await Promise.all(skills.map(async (sk) => [sk.id, await skillTimesAsync(nakedM, sk.id, sk.lv)])));
	// スキルの固定詠唱・CTは戦闘計算まで回すので重い（1スキルで本体の計算の1.5倍ほど）。
	// 入れ替える物がスキルの短縮に関係しないときは計算せず、ref（比べる元）の値をそのまま使う
	const skKeys = keys.filter((k) => k.startsWith("sk:"));
	const relSk = skills.length ? makeRelevance(skKeys) : null;
	const evalM = async (m, ref = null) => {
		let r;
		if (ref && skills.length) {
			r = await evalAllAsync(m, [], naked, cards, elms);
			for (const k of skKeys) r[k] = ref[k];
			for (const sk of skills) r[`skraw:${sk.id}`] = ref[`skraw:${sk.id}`];
		} else r = await evalAllAsync(m, skills, naked, cards, elms);
		return r;
	};
	const skRef = (isRel, ref) => (relSk && !isRel ? ref : null);
	const meets = (val) => conds.every((c) => val[c.key] - c.target >= -1e-9);
	const coreKeys = conds.filter((c) => !c.key.startsWith("sk:"));

	const baseVal = await evalM(base);
	// ASPD は足し算で見込まず、らとりおの式（ASPD = 前 + (200 - 前)×ASPD%/100 + 固定増加）で組み立てる。
	// 探索では内訳（ASPD%を掛ける前の値・ASPD%・固定増加）をそれぞれ足し算で持ち回り、ASPD はその都度この式で出す。
	// 上限（193/190）と小数1桁の切り捨ての前の値で比べる（目標が上限以下なら同じこと）。式が基準の構成で合わないとき（オーバードブーストで固定など）は今までどおり足し算
	const aspdCond = conds.find((c) => c.key === "aspd");
	const ax0 = aspdCond && !baseVal.aspdFixed && aspdCond.target <= baseVal.aspdCap && Math.abs(aspdOf(baseVal.aspdA, baseVal.aspdP, baseVal.aspdF) - baseVal.aspdRaw) < 1e-6;
	const dims = ax0 ? [...conds.map((c) => (c === aspdCond ? { ...c, key: "aspdRaw" } : c)), ...["aspdA", "aspdP", "aspdF"].map((key) => ({ key, target: AUX_NEED, aux: true }))] : conds;
	keys = dims.map((c) => c.key);
	const ax = ax0 ? { iA: keys.indexOf("aspdA"), iP: keys.indexOf("aspdP"), iF: keys.indexOf("aspdF"), a: baseVal.aspdA, p: baseVal.aspdP, f: baseVal.aspdF, T: aspdCond.target } : null;
	const need = dims.map((c) => (c.aux ? AUX_NEED : c.target - baseVal[c.key]));
	const baseWeapon = base.equip[R.EQUIP_REGION_ID_ARMS];
	// 今の装備で全部の目標を満たしているなら、探さずに「変更なし」を返す
	if (meets(baseVal)) {
		const results = [{ toks: [], picks: [], values: baseVal, price: 0, priceUnknown: 0, changes: 0, cost: 0, model: base }];
		onResults(results.slice(), { base, baseVal });
		return { results, baseVal, base, candidates: 1, stats: { unreachable: [], items: 0, cards: 0, sets: 0, packages: 0 } };
	}

	let lastYield = performance.now();
	const tick = async () => {
		if (performance.now() - lastYield > 40) {
			await new Promise((res) => setTimeout(res, 0));
			lastYield = performance.now();
		}
		if (shouldStop()) throw new BfStopped();
	};
	// 画面を止めうる同期処理の長さを計り、0.3秒を超えたら「考えていること」に出す（原因の切り分け用）
	const stall = (label, t0) => { const ms = performance.now() - t0; if (ms > 300) say(`画面を止めた処理: ${label} ${(ms / 1000).toFixed(1)}秒`); };
	const vecFrom = (v, ref) => keys.map((k) => v[k] - ref[k]);
	const relevant = (d) => d.some((x, i) => x > 1e-9 && need[i] > 0);
	const zero = () => keys.map(() => 0);

	// ---- 候補の絞り込み ----
	onProgress("候補を調べています", 0);
	const L = Object.fromEntries(BF_REGIONS.map((r) => {
		// シャドウ装備は探さない（常に今のまま）
		const x = r.shadow ? { item: true, refine: true, card: true, ench: true } : lock[r.key] || {};
		return [r.key, { item: !!x.item, refine: !!x.refine, card: !!x.card, ench: !!x.ench, fill: !!x.fill }];
	}));
	// 二刀流（左手に武器）のときは盾を付けられない。盾の部位は探さず、両手武器も出さない
	const nitou = Number(base.weapon?.weapon2Type ?? 0) !== 0;
	// 両手武器を固定しているときも盾は付けられない
	if (nitou || (L.weapon.item && isTwoHanded(baseWeapon))) L.shield = { item: true, refine: true, card: true, ench: true, fill: false };
	// カード・エンチャントだけ固定した部位は、装備を入れ替えても今のカード・エンチャントをそのまま付ける
	// （カードは枠が足りる装備、エンチャントはその枠に同じものが付く装備だけ）。keepSlots: 部位 → [[枠, ID, カードか]]
	const keepSlots = new Map();
	for (const r of BF_REGIONS) {
		if (L[r.key].item || !(L[r.key].card || L[r.key].ench) || isRegionEmpty(base, r)) continue;
		const n = itemSlotCount(regionItem(base, r));
		const list = [];
		r.slots.forEach((slot, i) => {
			const cid = slot >= 0 ? base.card[slot] || 0 : 0;
			if (cid > 0 && (i < n ? L[r.key].card : L[r.key].ench)) list.push([slot, cid, i < n, i]);
		});
		if (list.length) keepSlots.set(r.key, list);
	}
	const keepOk = (r, iid, lv) => {
		const list = keepSlots.get(r.key);
		if (!list) return true;
		const n = itemSlotCount(iid);
		const detail = enchantDetailOf(iid);
		return list.every(([, cid, isCard, i]) => isCard ? i < n : i >= n && detail[i]?.has(cid) && detail[i].get(cid) <= lv);
	};
	/** 装備を置く（固定したカード・エンチャントは残す） */
	const place = (m, r, iid, lv) => {
		placeItem(m, r, iid, lv);
		for (const [slot, cid] of keepSlots.get(r.key) || []) m.card[slot] = cid;
	};
	const keepItem = BF_REGIONS.filter((r) => L[r.key].item).map((r) => r.key);
	// 空いている枠の数（固定した装備でも、空いているカード・エンチャント枠は探す: fill）
	const emptySlots = (r) => {
		if (isRegionEmpty(base, r)) return 0;
		const n = itemSlotCount(regionItem(base, r));
		const detail = enchantDetailOf(regionItem(base, r));
		return r.slots.filter((slot, i) => slot >= 0 && !(base.card[slot] > 0) && (i < n || detail[i]?.size)).length;
	};
	const regions = BF_REGIONS.filter((r) => !(L[r.key].item && L[r.key].card && L[r.key].ench) || (L[r.key].fill && emptySlots(r) > 0) || (L[r.key].item && r.refine && !L[r.key].refine && !isRegionEmpty(base, r)));
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
		// 武器を何も持っていないときは、武器の種類で変わるもの（ASPD・クリティカル・スキルの使用など）が多いので、
		// 目標に関係なく、効果の無い武器でも全部の種類を候補にする（種類ごと・スロット数ごとに一番安いもの）。
		// 目標に関係するエンチャントが付く武器は、上の判定で種類を問わず候補に入っている
		const unarmed = r.key === "weapon" && isRegionEmpty(base, r);
		for (const id of all) {
			if (rel.item(id) || enchOf(id).some((a) => a.length)) { out.push(id); continue; }
			if (unarmed) {
				const hk = ItemObjNew[id][IDX_KIND] + ":" + itemSlotCount(id);
				const p = priceOf("item", id) ?? Infinity;
				const cur = hosts.get(hk);
				if (!cur || p < cur.p) hosts.set(hk, { id, p });
				continue;
			}
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
	// 今何を調べているかの生データ（画面の暇つぶし用）。文章を作る手間を避けるため、60ms に1回だけ作る
	let lastAct = 0;
	// 今していること・考えていることの文章（画面の最上段の枠に流す。節目ごとに必ず出す）
	const t00 = performance.now();
	const clock = () => { const sec = Math.floor((performance.now() - t00) / 1000); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`; };
	const say = (text) => onActivity(`[${clock()}] ${text}`, -2);
	const act = (fn) => { const t = Date.now(); if (t - lastAct < 30) return; lastAct = t; onActivity(fn(), -1); };

	// ---- カード・エンチャのセット（複数のカードを同時に付けて初めて効く効果）----
	// 1枚ずつの効き目の足し算には出ないので、セットごとに「そろったときの上乗せ分」を実計算で求めておき、
	// 枠を解くときに、そのセットのカードが全部そろったら足す（例: 騎士サクライ + 英雄の凱歌 で無属性耐性+20）
	const memberCard = new Set(); // セットのメンバーになりうるカード（効き目が無くても候補に残す）
	const cardSets = []; // { members: [カードID...], c: 上乗せ分, carrier: 上限の見積もりを足すカード }
	const carriedBy = new Map(); // カードID → そのカードが運ぶセットの番号
	{
		const baseHas = new Set();
		for (let i = 0; i < base.card.length; i++) if (base.card[i] > 0) baseHas.add(base.card[i]);
		const avail = new Map(); // 付けられるカード → 候補に出てくる部位の数
		const addAvail = (c) => avail.set(c, (avail.get(c) || 0) + 1);
		regionCards.forEach((l) => l.forEach(addAvail));
		regions.forEach((r, ri) => {
			const cur = isRegionEmpty(base, r) ? 0 : regionItem(base, r);
			const seen = new Set();
			for (const iid of [cur, ...regionItems[ri]]) if (iid) for (const a of enchOf(iid)) for (const c of a) seen.add(c);
			seen.forEach(addAvail);
		});
		const free = [];
		for (const r of BF_REGIONS) if (!r.shadow) for (const sl of r.slots) if (sl >= 0 && !(base.card[sl] > 0)) free.push(sl);
		const cands = new Map(); // メンバーの並び → { missing, partners }
		for (let i = 1; i < w_SE.length; i++) {
			const st = w_SE[i];
			if (!st || st.length < 3) continue;
			const mem = st.slice(1).filter((x) => x !== "NULL");
			if (!mem.every((x) => typeof x === "number" && x < 0)) continue;
			if (!rel.setRow(st[0])) continue;
			const all = [...new Set(mem.map((x) => -x))];
			const missing = all.filter((c) => !baseHas.has(c)).sort((a, b) => a - b);
			if (missing.length < 2 || missing.length > 5) continue;
			if (!missing.every((c) => avail.has(c) && !ngCardSet.has(c))) continue;
			const key = missing.join(",") + "|" + all.filter((c) => baseHas.has(c)).sort((a, b) => a - b).join(",");
			cands.set(key, { missing, partners: all.filter((c) => baseHas.has(c)) });
		}
		const slotsAll = [];
		for (const r of BF_REGIONS) if (!r.shadow) for (const sl of r.slots) if (sl >= 0) slotsAll.push(sl);
		await pmap([...cands.values()], async ({ missing, partners }) => {
			await tick();
			// 土台: ほかのカードを全部外し、同じセットのカード（もう付いているもの）だけ残す。そこへメンバーを1枚ずつ足した実計算
			const scratch = cloneModel(base);
			const pset = new Set(partners);
			const used = new Set();
			for (const sl of slotsAll) { if (pset.has(scratch.card[sl])) used.add(sl); else scratch.card[sl] = 0; }
			const open = slotsAll.filter((sl) => !used.has(sl));
			if (open.length < missing.length) return;
			const m = missing.length;
			const vals = new Array(1 << m);
			await pmap(Array.from({ length: 1 << m }, (_, mask) => mask), async (mask) => {
				const mm = cloneModel(scratch);
				missing.forEach((c, j) => { if ((mask >> j) & 1) mm.card[open[j]] = c; });
				const v = await evalM(mm);
				vals[mask] = keys.map((k) => v[k]);
			}, CONC);
			// n枚そろって初めて出る分 = 部分集合の効果を引いたもの（包除原理）
			let c = zero();
			for (let mask = 0; mask < (1 << m); mask++) {
				let bits = 0; for (let j = 0; j < m; j++) bits += (mask >> j) & 1;
				const sign = ((m - bits) % 2) ? -1 : 1;
				c = c.map((x, k) => x + sign * vals[mask][k]);
			}
			if (c.some((x, k) => x > 1e-9 && need[k] > 0)) cardSets.push({ members: missing, c });
		}, CONC);
		cardSets.sort((a, b) => a.members.join(",").localeCompare(b.members.join(",")));
		for (const [si, st] of cardSets.entries()) {
			for (const c of st.members) memberCard.add(c);
			// 上限の見積もりは、一番少ない部位にしか出てこないメンバーに足す（そのカードを選ばないとそろわない）
			const carrier = st.members.slice().sort((a, b) => (avail.get(a) - avail.get(b)) || (a - b))[0];
			st.carrier = carrier;
			if (!carriedBy.has(carrier)) carriedBy.set(carrier, []);
			carriedBy.get(carrier).push(si);
		}
	}

	const regionVariants = [];
	const regionCtx = [];
	const slotChoicesFor = async (ctx, iid, lv) => {
		const nSlot = itemSlotCount(iid);
		const detail = enchantDetailOf(iid);
		const ench = enchOf(iid).map((a, s) => a.filter((cid) => (detail[s].get(cid) ?? 0) <= lv));
		const out = [];
		const kept = new Set((keepSlots.get(ctx.r.key) || []).map((x) => x[0]));
		for (let s = 0; s < 4; s++) {
			if (ctx.r.slots[s] == null || ctx.r.slots[s] < 0 || kept.has(ctx.r.slots[s])) { out.push([]); continue; }
			if (s < nSlot) {
				// カードも、装備で効果が変わるもの（同じセット・精錬条件など）はその装備を付けた状態で差分を取る
				if (!ctx.cardAll.some((o) => hostDependent(o.id, iid, lv))) { out.push(ctx.cardOpts); continue; }
				const ds = await pmap(ctx.cardAll, async (o) => { if (!hostDependent(o.id, iid, lv)) return o.d; await tick(); return ctx.hostDelta(iid, lv, s, o.id); }, CONC);
				out.push(ctx.cardAll.map((o, j) => ({ id: o.id, d: ds[j] })).filter((o) => ctx.relevant(o.d) || memberCard.has(o.id)));
				continue;
			}
			const ds = await pmap(ench[s] || [], async (cid) => { await tick(); return ctx.hostDelta(iid, lv, s, cid); }, CONC);
			out.push((ench[s] || []).map((cid, j) => ({ id: cid, d: ds[j] })).filter((o) => ctx.relevant(o.d) || memberCard.has(o.id)));
		}
		return out;
	};

	// ---- カード・エンチャ枠（あとから解く）----
	// 枠の候補は、他に全部の点で負けているものを捨て、値段の安い順に並べる（先頭は「そのまま」）。中身が同じ枠は同じ def を使い回す
	const W = need.map((x) => (x > 0 ? 1 / x : 0));
	const defCache = new Map();
	const priceOfCard = (id) => (isEnchant(id) ? 0 : priceOf("card", id) ?? UNKNOWN_PRICE);
	const getDef = (ctx, list, capNeed) => {
		const key = ctx.ri + "|" + (capNeed === need ? "n" : "r") + "|" + JSON.stringify(list.map((o) => [o.id, o.d.map((y) => Math.round(y * 1000))]));
		let def = defCache.get(key);
		if (def) return def;
		const cand = list.map((o) => ({ id: o.id, d: o.d, price: priceOfCard(o.id), count: 1, changed: 1, cards: [[0, o.id]] }));
		const kept = paretoPrune(cand, capNeed);
		// セットのメンバーは、他に負けていても残す（そろうと上乗せがある）
		const have = new Set(kept.map((v) => v.id));
		for (const v of cand) if (memberCard.has(v.id) && !have.has(v.id)) kept.push(v);
		// 新しいもの（IDの大きい順）から試す（ユーザー指定。打ち切りで落ちるのは古い物になる）
		kept.sort((a, b) => b.id - a.id || a.price - b.price);
		def = finishDef({ id: defCache.size, opts: [{ id: 0, d: zero(), price: 0, cnt: 0, sets: [] }, ...kept.map((v) => ({ id: v.id, d: v.d, price: v.price, cnt: 1, sets: carriedBy.get(v.id) || [] }))] }, need, W, cardSets);
		defCache.set(key, def);
		return def;
	};
	const groupsFor = (ctx, slotChoices, tag, capNeed) => {
		const groups = [];
		slotChoices.forEach((list, s) => {
			if (!list || !list.length) return;
			let def;
			if (list === ctx.cardOpts && capNeed === ctx.needR) def = ctx.cardDef ||= getDef(ctx, list, capNeed);
			else def = getDef(ctx, list, capNeed);
			if (def.opts.length > 1) groups.push({ def, slot: s });
		});
		return groups;
	};

	// 部位ごとの候補づくりは部位どうしでも並列に回す（1部位ずつだと Worker が空く）。結果は部位の並びで入れる
	await pmap(regions, async (r, ri) => {
		const curItem = isRegionEmpty(base, r) ? 0 : regionItem(base, r);
		const curCards = r.slots.map((s) => base.card[s] || 0);
		onProgress("候補を調べています", done / totalWork);

		// 部位を空にした状態（入れ替え時のカード・エンチャの差分の基準）
		const cleared = cloneModel(base);
		clearRegion(cleared, r);
		const clearedVal = await evalM(cleared);
		const clearedD = vecFrom(clearedVal, baseVal);
		// この部位の候補は「部位を空にした状態」から見た足りない分で選ぶ。
		// 今の装備（または外した部位に残ったカード・エンチャ）で満たしている目標は、入れ替えると失うので、取り戻す物も候補に残す
		const needR = dims.map((c, i) => c.aux ? AUX_NEED : (need[i] > 0 || c.target - clearedVal[c.key] > 1e-9) ? Math.max(c.target - clearedVal[c.key], 1e-6) : 0);
		const relevantR = (d) => d.some((x, i) => x > 1e-9 && needR[i] > 0);
		const toR = (d) => d.map((x, i) => x - clearedD[i]);
		const fromR = (list) => { for (const v of list) v.d = v.d.map((x, i) => x + clearedD[i]); return list; };
		const cardDelta = new Map();
		const slotDelta = (s, cid) => {
			// 効果はどの枠に挿しても同じなので、エンチャント・カードごとに1回だけ計算する
			const key = cid;
			if (!cardDelta.has(key)) {
				const m = cloneModel(cleared);
				m.card[r.slots[s]] = cid;
				cardDelta.set(key, evalM(m, skRef(relSk?.card(cid), clearedVal)).then((v) => vecFrom(v, clearedVal)));
			}
			return cardDelta.get(key);
		};

		// エンチャントは付ける装備・精錬値で効果が変わる（例: 英雄の凱歌はヴァルキリーカースブライト+10でASPDが大きく上がる）ので、
		// 差分はその装備をその精錬値で付けた状態を基準に取る
		const hostCache = new Map();
		const hostDelta = (iid, lv, s, cid) => {
			// 装備によって効果が変わらないエンチャントは、空の部位での差分を使い回す（計算を減らす）
			if (!hostDependent(cid, iid, lv)) return slotDelta(s, cid);
			// 精錬値の条件だけなら、装備は何でも同じなので「空の部位をその精錬値にしたもの」を基準にする（装備ごとに計算しない）
			const byItem = inSameSet("c" + cid, "i" + iid) || (isHardCard(cid) && isEnchant(cid));
			const hk = byItem ? iid + ":" + lv : "R:" + lv;
			let h = hostCache.get(hk);
			if (!h) {
				const m = cloneModel(cleared);
				if (byItem) place(m, r, iid, lv); else setRefine(m, r, lv);
				h = { m, val: evalM(m) };
				hostCache.set(hk, h);
			}
			const key = hk + ":" + cid;
			if (!cardDelta.has(key)) {
				cardDelta.set(key, h.val.then(async (hv) => {
					const m = cloneModel(h.m);
					m.card[r.slots[s]] = cid;
					return vecFrom(await evalM(m, skRef(relSk?.card(cid), hv)), hv);
				}));
			}
			return cardDelta.get(key);
		};

		// カード候補（差分は空の部位に入れたときのもの。カード枠どこに挿しても同じとみなす）
		const cardDs = await pmap(regionCards[ri], async (cid) => { await tick(); done++; act(() => `${r.label}  カード ${cardName(cid)}  ${done}/${totalWork}`); return slotDelta(0, cid); }, CONC);
		const cardAll = regionCards[ri].map((cid, j) => ({ id: cid, d: cardDs[j] }));
		const cardOpts = cardAll.filter((o) => relevantR(o.d) || memberCard.has(o.id));
		const ctx = { r, ri, needR, cardAll, cardOpts, slotDelta, hostDelta, relevant: relevantR, keepVariants: [], cardDef: null };

		const variants = [];
		const twoHand0 = r.key === "weapon" && isTwoHanded(curItem);
		// a) そのまま
		variants.push({ region: r, keep: true, itemId: curItem, cards: [], groups: [], d: zero(), price: 0, count: 0, changed: 0, twoHand: twoHand0, usesShield: r.key === "shield" && !!curItem });

		// b) 今の装備のまま、カード・エンチャだけ変える（精錬値を探す部位は、他の精錬値でも同じことをする）
		// カード・エンチャ枠は、ここでは組み合わせず「枠」として持つ（探索の最後に、足りない分だけ解く）
		if (curItem) {
			const curLv = getRefine(base, r), curT = getTrans(base, r);
			const lvs = [{ lv: curLv, t: curT }];
			// 精錬値を探す部位は、今の精錬値以上（+0と+4〜+10だけ。+10の次は超越★1の+0から）を候補にする
			if (r.refine && !L[r.key].refine) for (const x of refineStepsFrom(curT, curLv)) lvs.push(x);
			for (const { lv: lv0, t: t0 } of lvs) {
				let baseR = base, baseValR = baseVal, refD = zero();
				const moved = lv0 !== curLv || t0 !== curT;
				let refRel = false;
				if (moved) {
					baseR = cloneModel(base);
					setRefine(baseR, r, lv0);
					setTrans(baseR, r, t0);
					baseValR = await evalM(baseR);
					refD = vecFrom(baseValR, baseVal);
					// 精錬値を変えるだけで目標に近づくか、その精錬値でないと付けられないエンチャがあるときだけ候補にする
					refRel = refD.some((x, i) => x > 1e-9 && need[i] > 0);
				}
				const refPrice = moved ? refineIndex(t0, lv0) - refineIndex(curT, curLv) : 0;
				const nSlot = itemSlotCount(curItem);
				const curDetail = enchantDetailOf(curItem);
				const ench = enchOf(curItem).map((a, s) => a.filter((cid) => (curDetail[s].get(cid) ?? 0) <= lv0));
				const slotChoices = [];
				for (let s = 0; s < 4; s++) {
					const opts = [];
					if (r.slots[s] == null || r.slots[s] < 0 || ((s < nSlot ? L[r.key].card : L[r.key].ench) && !(L[r.key].fill && !curCards[s]))) { slotChoices.push(opts); continue; }
					if (s < nSlot) {
						// 今のカードを外したときの差分を足す
						let removeD = zero();
						if (curCards[s] && cardAll.length) {
							const m0 = cloneModel(baseR);
							m0.card[r.slots[s]] = 0;
							removeD = vecFrom(await evalM(m0, skRef(relSk?.card(curCards[s]), baseValR)), baseValR);
						}
						// 装備で効果が変わるカードは、今の装備に挿した状態で計算する
						const list = cardAll.filter((o) => o.id !== curCards[s]);
						const ds = await pmap(list, async (o) => {
							if (!hostDependent(o.id, curItem, lv0)) return (relevantR(o.d) || memberCard.has(o.id)) ? o.d.map((x, i) => x + removeD[i]) : null;
							await tick();
							const m = cloneModel(baseR);
							m.card[r.slots[s]] = o.id;
							const d = vecFrom(await evalM(m, skRef(relSk?.card(o.id), baseValR)), baseValR);
							return (relevantR(d.map((x, i) => x - removeD[i])) || memberCard.has(o.id)) ? d : null;
						}, CONC);
						list.forEach((o, j) => { if (ds[j]) opts.push({ id: o.id, d: ds[j] }); });
					} else {
						const list = (ench[s] || []).filter((cid) => cid !== curCards[s]);
						const ds = await pmap(list, async (cid) => {
							await tick();
							const m = cloneModel(baseR);
							m.card[r.slots[s]] = cid;
							return vecFrom(await evalM(m, skRef(relSk?.card(cid), baseValR)), baseValR);
						}, CONC);
						list.forEach((cid, j) => { if (relevantR(ds[j]) || memberCard.has(cid)) opts.push({ id: cid, d: ds[j] }); });
					}
					slotChoices.push(opts);
				}
				const groups = groupsFor(ctx, slotChoices, "k" + curItem + ":" + lv0 + ":" + t0, need);
				// 精錬値を変えるだけで目標に近づくなら、枠はそのままでもよい。そうでなければ枠を1つは変える
				if (!(moved && refRel) && !groups.length) continue;
				variants.push({ region: r, keep: true, itemId: curItem, cards: [], groups, mustFill: !(moved && refRel), d: refD, price: refPrice, count: 0, changed: 1, twoHand: twoHand0, usesShield: variants[0].usesShield, setRefine: moved ? lv0 : undefined, setTrans: moved ? t0 : undefined });
			}
		}
		ctx.keepVariants = variants.slice();

		// c) 装備を入れ替える（装備ごとに並列に調べ、結果は元の並びで足す）
		const perItem = await pmap(regionItems[ri], async (iid) => {
			const variants = [];
			await tick();
			done++;
			if (done % 10 === 0) onProgress("候補を調べています", done / totalWork);
			if (iid === curItem) return variants;
			// 精錬値は+0が基本。過剰精錬で目標の効果が変わるとき・エンチャントに精錬値の条件があるときだけ、その精錬値も候補にする。
			// 装備自体に目標の効果が無い（エンチャントやカード枠のために入れた）ものは計算せず、部位を空にしたときと同じとみなす
			const hasKeep = keepSlots.has(r.key);
			const selfRel = rel.item(iid);
			const levels = L[r.key].refine ? [getRefine(base, r)]
				: selfRel ? refineLevelsOf(r, iid, rel.code)
				: [...new Set([0, ...enchantDetailOf(iid).flatMap((mm) => [...mm.values()])])].filter((v) => (v <= MAX_REFINE && r.refine && v >= 4) || v === 0).sort((a, b) => a - b);
			let prevD = null, prevEnch = -1;
			for (const lv of levels) {
				if (!keepOk(r, iid, lv)) continue;
				let d = clearedD;
				act(() => `${r.label}  ${itemName(iid)} +${lv}  ${done}/${totalWork}`);
				if (selfRel || hasKeep) {
					const m = cloneModel(cleared);
					place(m, r, iid, lv);
					d = vecFrom(await evalM(m, skRef(relSk?.item(iid), clearedVal)), baseVal);
				}
				const slotChoices = await slotChoicesFor(ctx, iid, lv);
				// 前の精錬値と装備の効果も付けられる物とその効果も同じなら、精錬値を上げる意味は無い
				const nEnch = JSON.stringify(slotChoices.map((o) => o.map((x) => [x.id, x.d.map((y) => Math.round(y * 1000))])));
				if (prevD && nEnch === prevEnch && d.every((x, i) => Math.abs(x - prevD[i]) < 1e-9)) continue;
				prevD = d; prevEnch = nEnch;
				if (!relevantR(toR(d)) && !slotChoices.some((o) => o.length)) continue;
				// 同じ性能なら精錬値の低い方が残るように、精錬値ぶんだけ値段を重くして比べる
				const itemPrice = (priceOf("item", iid) ?? UNKNOWN_PRICE) + lv;
				variants.push({ region: r, keep: false, itemId: iid, refine: lv, selfRel, cards: [], groups: groupsFor(ctx, slotChoices, "i" + iid, needR), d, price: itemPrice, count: 1, changed: 1, twoHand: r.key === "weapon" && isTwoHanded(iid), usesShield: r.key === "shield" });
			}
			return variants;
		}, CONC);
		for (const list of perItem) for (const v of list) variants.push(v);
		for (const v of variants) v.d = toR(v.d);
		regionVariants[ri] = paretoPrune(variants, needR);
		fromR(variants);
		regionCtx[ri] = ctx;
	}, regions.length);

	// ---- セット効果（複数部位をまとめて入れ替える候補） ----
	const regionIndex = new Map(regions.map((r, i) => [r.key, i]));
	const shieldLocked = !regionIndex.has("shield");
	const baseShield = nitou || !isRegionEmpty(base, BF_REGIONS.find((r) => r.key === "shield"));
	let pkgCount = 0;
	// セットごとの効き目の計算は並列に（Worker を遊ばせない）。候補への追加は元の並びで順に
	const prepSet = async (S) => {
		await tick();
		done++;
		if (done % 10 === 0) onProgress("候補を調べています", done / totalWork);
		act(() => `セット  ${S.members.map((id) => itemName(id)).join(" + ")}  ${done}/${totalWork}`);
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
		if (!ok || assign.every((a) => a.already)) return null;
		const wpn = assign.find((a) => a.region.key === "weapon" && !a.already);
		if (wpn && isTwoHanded(wpn.itemId) && (assign.some((a) => a.region.key === "shield") || (shieldLocked && baseShield))) return null;
		// セットのメンバーも+0から。効果が出なければ、各メンバーを候補の中で一番高い精錬値にして確かめる
		let d = null, bad = false;
		for (const top of [false, true]) {
			const m = cloneModel(base);
			for (const a of assign) {
				if (a.already) continue;
				const lvs = L[a.region.key].refine ? [getRefine(base, a.region)] : refineLevelsOf(a.region, a.itemId);
				a.refine = top ? lvs[lvs.length - 1] : lvs[0];
				if (!keepOk(a.region, a.itemId, a.refine)) { bad = true; break; }
				place(m, a.region, a.itemId, a.refine);
			}
			if (bad) break;
			d = vecFrom(await evalM(m), baseVal);
			if (relevant(d)) break;
			if (!assign.some((a) => !a.already && refineLevelsOf(a.region, a.itemId).length > 1)) break;
		}
		if (bad || !relevant(d)) return null;
		return { S, assign, d };
	};
	const preps = await pmap(sets, prepSet, CONC);
	for (const pr of preps) {
		if (!pr) continue;
		const { S, assign, d } = pr;
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
				vs = [{
					region: a.region, keep: false, itemId: a.itemId, refine: a.refine, cards: [], groups: groupsFor(ctx, slotChoices, "i" + a.itemId, need), d: zero(), price: priceOf("item", a.itemId) ?? UNKNOWN_PRICE, count: 1, changed: 1,
					twoHand: a.region.key === "weapon" && isTwoHanded(a.itemId), usesShield: a.region.key === "shield",
				}];
			}
			vs = paretoPrune(vs, need);
			for (const v of vs) {
				v.pkg = pkg;
				v.pkgHead = k === 0;
				if (k === 0) v.d = v.d.map((x, i) => x + d[i]);
				regionVariants[idx].push(v);
			}
		}
		pkgCount++;
	}

	say(`候補がそろいました: ${regionVariants.map((l, i) => `${regions[i]?.label ?? i} ${l.length}件`).join(" / ")}（セット ${pkgCount}件、カードの組み合わせ効果 ${cardSets.length}件）`);
	// ---- 組み合わせ探索 ----
	// 装備（と精錬値）を部位ごとに選び、カード・エンチャ枠は最後に足りない分だけ解く（モンハンのシミュレーターの装飾品の当てはめと同じ）。
	// 変える部位の数が少ない順（0か所→1か所→…）に探し、その数の中では深さ優先＋上限による枝刈り。
	// 候補を上位N件に絞る切り捨ては一切しない（捨てるのは、全部の点で他に負けている物だけ）ので、足し算の見込みで届く組み合わせは見落とさない。
	// 結果は「変更が少ない順→使うカードが少ない順→安い順」なので、ある数で表示件数がそろったら、それより多い数は探さない
	phase = [0.75, 1];
	onProgress("組み合わせを探しています", 0);
	const weaponLocked = !regionIndex.has("weapon");
	const n = regionVariants.length;
	const K = keys.length;
	// 各候補の「枠まで含めた一番良い場合」の伸び U と目標への近さ P（探索の上限の計算用. 枠はどれでも好きなカードを挿せるものとして多めに見積もる）
	for (const list of regionVariants) {
		for (const v of list) {
			v.groups = v.groups || [];
			const U = v.d.slice();
			let P = pPlus(v.d, need, W);
			for (const g of v.groups) { for (let k = 0; k < K; k++) U[k] += g.def.mx[k]; P += g.def.mp; }
			v.U = U; v.P = P;
		}
	}
	// 部位ごとの、目標ごとの一番大きい伸び
	const bestOf = regionVariants.map((list) => keys.map((_, k) => { let b = 0; for (const v of list) if (v.U[k] > b) b = v.U[k]; return b; }));
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
	// いま探索に使う候補の一覧（最初は届くかどうかだけを調べる軽い一覧、次に全部）と、それに合わせた上限の準備
	let LV = regionVariants;
	let LVU = regionVariants; // 上限の計算に使う、U で負ける候補を除いた一覧
	let topSumP = [], lossFrom = [];
	const prepLists = (lists) => {
		const tP = performance.now();
		LV = lists;
		LVU = lists.map(reduceByU);
		// 目標への近さ（全目標をまとめた1つのものさし）の上限. 目標ごとの上限が届いていても、全部を合わせると届かないものを早く切る
		const bestP = lists.map((list) => { let b = 0; for (const v of list) if (v.P > b) b = v.P; return b; });
		topSumP = [];
		for (let i = 0; i <= n; i++) {
			const arr = bestP.slice(i).sort((x, y) => y - x);
			const pre = [0];
			for (const x of arr) pre.push(pre[pre.length - 1] + x);
			topSumP[i] = pre;
		}
		// 後ろの部位で下がる分の最大（これより先の部位の候補が目標を下げる分. 先に決めた部位が余分に見えても、あとで下がるなら必要なことがある）
		lossFrom = [];
		for (let i = 0; i <= n; i++) {
			const loss = new Float64Array(K);
			for (let j = i; j < n; j++) for (let k = 0; k < K; k++) { let m = 0; for (const v of lists[j]) if (v.d[k] < m) m = v.d[k]; loss[k] -= m; }
			lossFrom[i] = loss;
		}
		stall("候補一覧の準備", tP);
	};
	const upperP = (i, b) => { const pre = topSumP[i]; return pre[Math.min(b, pre.length - 1)]; };
	// 全部の部位で一番伸びるものを選んでも届かない条件（足し算の見込み）。結果が0件のときに知らせる
	const unreachable = dims.filter((c, k) => !c.aux && upper(0, k, n) < need[k] - 1e-9).map((c) => c.label || c.key);
	if (ax && !unreachable.includes(aspdCond.label || "aspd") && aspdUpper(ax.a + upper(0, ax.iA, n), ax.p + upper(0, ax.iP, n), ax.f + upper(0, ax.iF, n)) < ax.T - 1e-9) unreachable.push(aspdCond.label || aspdCond.key);
	const normOf = (k) => Math.max(1, Math.abs(dims[k].target) * 0.05);
	const scaleOf = need.map((x, k) => (x > 0 ? x : normOf(k)));

	// 見つけた組み合わせは、その場で実計算で確かめて結果に入れる（onResults で途中経過を返す）
	const costOf = (f) => f.picks.reduce((a, v) => a + v.price, 0);
	const changesOf = (f) => f.picks.reduce((a, v) => a + v.changed, 0);
	// 変更か所が同じなら、カード・エンチャの数が少ない（空き枠が多い）方を上に。値段はその次
	const usedOf = (m) => BF_REGIONS.reduce((n, r) => n + r.slots.filter((sl) => sl >= 0 && m.card[sl] > 0).length, 0);
	const order = (a, b) => (a.changes - b.changes) || ((a.used ?? 0) - (b.used ?? 0)) || (a.cost - b.cost);
	const results = [];
	const seen = new Set();
	let foundCount = 0;
	let lastEmit = 0;
	const emit = (force) => {
		if (!force && performance.now() - lastEmit < 500) return;
		lastEmit = performance.now();
		onResults(results.slice(), { base, baseVal });
	};
	const verify = async (picks) => {
		const f = { picks, changes: changesOf({ picks }), cost: costOf({ picks }) };
		const m = cloneModel(base);
		for (const v of picks) {
			if (!v.changed) continue;
			const r = v.region;
			if (!v.keep) place(m, r, v.itemId, v.refine ?? 0);
			else if (v.setRefine != null) { setRefine(m, r, v.setRefine); setTrans(m, r, v.setTrans ?? 0); }
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
		const toks = picks.filter((v) => v.changed).flatMap((v) => [...(v.keep ? (v.setRefine != null ? [`${ACC_SIDE[v.region.key] || v.region.key}:r${v.setRefine}t${v.setTrans ?? 0}`] : []) : [`${ACC_SIDE[v.region.key] || v.region.key}:i${v.itemId}:${v.refine ?? 0}`]), ...v.cards.map(([, cid]) => `${ACC_SIDE[v.region.key] || v.region.key}:c${cid}`)]).sort();
		if (results.some((x) => within(x.toks, toks))) return;
		// まず本体の計算だけで、スキル以外の条件を満たすか確かめる（スキルの計算は重いので後回し）
		if (skills.length) {
			const core = await evalAllAsync(m, [], naked, cards, elms);
			if (!coreKeys.every((c) => core[c.key] - c.target >= -1e-9)) return;
		}
		const val = await evalM(m);
		if (!meets(val)) { say(`実計算で確認 ×: ${conds.filter((c) => val[c.key] - c.target < -1e-9).map((c) => `${c.label || c.key} ${(val[c.key] - c.target).toFixed(1)}`).join("、")} が足りませんでした（足し算の見込みと実際のずれ）`); return; }
		if (results.some((x) => within(x.toks, toks))) return;
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
		say(`実計算で確認 ○: 条件を満たす構成が見つかりました（変更${f.changes}か所）`);
		results.push({ toks, picks: changed, values: val, price, priceUnknown: unknown, changes: f.changes, cost: f.cost, used: usedOf(m), model: m });
		results.sort(order);
		if (results.length > maxResults) results.length = maxResults;
		emit(false);
	};

	// ---- 深さ優先の総当たり（枝刈りつき）----
	let nodes = 0;
	let budget = 0;
	const FILL_WANT = 3;
	// 足し算の見込みでは届くのに実計算では届かない構成が続くときに、探し続けないための上限（それでも十分大きい）
	const totalLimit = Math.max(20000, maxResults * 2000);
	// 見つけた枠の埋め方は、まとめて並列に実計算して確かめる
	const queue = [];
	const flush = async () => {
		if (!queue.length) return;
		const q = queue.splice(0);
		await Promise.all(q.map((p) => { foundCount++; return verify(p); }));
	};
	// 表示件数がそろっても、安い順・カードの少ない順に良い物が残るように、ある程度は探し続ける
	const enoughAt = maxResults * 6;
	const failMemo = new Map();
	let feasMode = false, feasFound = false;
	const finished = () => (feasMode ? feasFound : (results.length >= maxResults && foundCount >= enoughAt) || foundCount >= totalLimit);
	// 探索は小さな仕事（途中まで決めた組から先を探す）に分けて、Worker の束に配る（Worker が使えないときはこの画面のスレッドで順に）。
	// 仕事が時間内に終わらなければ、結果を捨てて1部位ぶん細かく分け直す
	const TASK_MS = 300;
	const tasksCtx = () => ({ trail: true, n, K, ax, need, W, scaleOf, LV, LU: levelLU, cardSets, FILL_WANT, shieldLocked, baseShield, startTwoHand, topSumP, lossFrom, failMemo, budget, feas: feasMode, nL, topL, lneed });
	let levelLU = [];
	const searchLevel = async () => {
		const ctx = tasksCtx();
		const workers = pool.available();
		const tB = performance.now();
		if (workers) {
			if (poolBase !== LV) { pool.broadcast("dfsBase", packBase({ n, K, ax, need, W, scaleOf, LV, cardSets, FILL_WANT, shieldLocked, baseShield, startTwoHand, topSumP, lossFrom })); poolBase = LV; }
			pool.broadcast("dfsLevel", { trail: true, LU: levelLU, budget, feas: feasMode, nL, topL, lneed });
		}
		stall("計算スレッドへの下準備の送信", tB);
		// 仕事の置き場（後ろから取り出す。細かく分けた組は逆順に積んで、元の順に取り出す）
		const taskQ = [{ prefix: [], w: 1 }];
		let lastProg = 0;
		let doneW = 0;
		const exec = async (t) => {
			if (workers) {
				for (let tries = 0; ; tries++) {
					try { return await pool.run("dfs", { prefix: t.prefix, ms: t.prefix.length >= n ? 0 : TASK_MS }); } catch (e) {
						if (e instanceof pool.CancelError) throw new BfStopped();
						// Worker が落ちたときは、作り直した Worker に同じ仕事を出し直す
						if (e instanceof pool.WorkerCrash && tries < 5) { onActivity(`[${clock()}] 計算スレッドが落ちたので作り直して出し直します（${pool.lastError()}）`, -2); continue; }
						throw e;
					}
				}
			}
			await tick();
			return dfsTask(ctx, t.prefix, t.prefix.length >= n ? 0 : TASK_MS);
		};
		const capN = workers ? pool.poolSize() * 2 : 1;
		let active = 0, failed = null, created = 1, finishedTasks = 0, aborts = 0;
		let cappedN = 0;
		const lvT0 = performance.now(), nodes0 = nodes;
		say(`変更${budget}か所の探索を開始（${workers ? `${pool.poolSize()}スレッドで並列（この端末の論理コア ${navigator.hardwareConcurrency || "不明"}）` : "この画面のスレッドのみ"}）`);
		const hb = setInterval(() => {
			const sec = (performance.now() - lvT0) / 1000;
			onActivity(`[${clock()}] 変更${budget}か所 ｜ 探索済み 約${(Math.min(1, doneW) * 100).toFixed(1)}% ｜ 仕事 ${finishedTasks}/${created}（分け直し ${aborts}回、待ち ${taskQ.length}） ｜ ${(nodes - nodes0).toLocaleString()}手（毎秒 ${Math.round((nodes - nodes0) / Math.max(sec, 0.1)).toLocaleString()}） ｜ 確認待ち ${queue.length}件 ｜ 結果 ${results.length}件`, -3);
		}, 500);
		await new Promise((resolve) => {
			const pump = () => {
				if (failed) { if (!active) resolve(); return; }
				if (shouldStop()) failed = new BfStopped();
				while (!failed && active < capN && taskQ.length && !finished()) {
					const t = taskQ.pop();
					active++;
					exec(t).then(async (r) => {
						const tR = performance.now();
						nodes += r.nodes; finishedTasks++;
						showTrail(r);
						if (r.capped) { cappedN += r.capped; onActivity(`[${clock()}] 枠の当てはめが手数の上限（${(3e6).toLocaleString()}手）に達して打ち切った装備の組があります（累計 ${cappedN}組）。この組は結果に入っていない可能性があります`, -2, "capped"); }
						if (r.aborted) {
							// 時間切れ: 調べ終えた候補の分（kept）は結果を使い、残りを細かく分けて積み直す
							aborts++; created += r.sub.length;
							const parts = r.sub.length + (r.kept || 0);
							for (let q = r.sub.length - 1; q >= 0; q--) taskQ.push({ prefix: r.sub[q], w: t.w / parts });
							doneW += parts ? t.w * (r.kept || 0) / parts : t.w;
						} else doneW += t.w;
						if (r.found) feasFound = true;
						for (const lf of r.leaves) for (const sol of lf.sols) queue.push(buildPicks(lf.idx, sol));
						stall("仕事の結果の取り込み", tR);
						if (queue.length >= CONC) await flush();
						if (performance.now() - lastProg > 200) onProgress(results.length ? `組み合わせを探しています（${results.length}件）` : "組み合わせを探しています", Math.min(0.95, (budget + Math.min(1, doneW)) / (n + 1)));
						if (performance.now() - lastProg > 200) lastProg = performance.now();
					}).catch((e) => { failed = failed || e; }).finally(() => { active--; pump(); });
				}
				if (!active && (failed || !taskQ.length || finished())) resolve();
			};
			pump();
		});
		clearInterval(hb);
		if (failed) throw failed;
	};
	let poolBase = null;
	// 仕事で見た組み合わせの見本を、Worker（スレッド）ごとの枠に流す。変えた部位の装備だけを並べる
	const showTrail = (r) => {
		if (!r.trail) return;
		for (const idx of r.trail) {
			const parts = [];
			for (let j = 0; j < idx.length; j++) {
				const v = LV[j][idx[j]];
				if (v.changed) parts.push(`${v.region.label} ${itemName(v.itemId)}${v.refine ? "+" + v.refine : ""}${v.cards.length ? "(" + v.cards.map(([, c]) => cardName(c)).join("・") + ")" : ""}${v.groups.length ? " 枠" + v.groups.length : ""}`);
			}
			onActivity(`${idx.length}/${n} ${parts.length > 3 ? "… / " : ""}${parts.slice(-3).join(" / ") || "(変更なし)"}`, r.lane ?? 0);
		}
	};
	const buildPicks = (idx, sol) => {
		const picks = idx.map((vi, j) => LV[j][vi]);
		const groups = [], owner = [];
		for (let j = 0; j < n; j++) { const v = picks[j]; if (!v.changed) continue; for (const g of v.groups) { groups.push(g); owner.push(j); } }
		const add = new Map();
		sol.pick.forEach((oi, gi) => {
			if (!oi) return;
			const g = groups[gi], o = g.def.opts[oi], j = owner[gi];
			let e = add.get(j);
			if (!e) add.set(j, e = { cards: [], d: picks[j].d.slice(), price: picks[j].price });
			e.cards.push([picks[j].region.slots[g.slot], o.id]);
			for (let k = 0; k < K; k++) e.d[k] += o.d[k];
			e.price += o.price;
		});
		for (const [j, e] of add) picks[j] = { ...picks[j], cards: e.cards, d: e.d, price: e.price, count: picks[j].count + e.cards.length };
		return picks;
	};
	// 重み付きの上限（目標ごと・全体・最適化した重み）. 変える部位の数 b ごとに重みを求め直し、届かないと証明できたらその b は飛ばす
	let nL = 0, topL = [], lneed = new Float64Array(0);
	let prevLam = null, lastF = null;
	const setupLevel = async (b) => {
		const lams = [];
		for (let k = 0; k < K; k++) { const e = new Float64Array(K); e[k] = 1; lams.push(e); }
		lams.push(Float64Array.from(W));
		const starts = [Float64Array.from(scaleOf, (x) => 1 / x), Float64Array.from(W.map((x, k) => (x > 0 ? x : 0.1 / scaleOf[k])))];
		if (prevLam) starts.push(prevLam);
		const opt = await optimizeLambda(LVU, need, scaleOf, b, starts, 200, tick);
		lastF = opt.length ? opt[0].val : null;
		if (opt.length && opt[0].val < -1e-6 * (1 + Math.abs(opt[0].val))) { say(`${b}か所の変更では、どう選んでも届かないと上限の計算で証明できました（余裕 ${opt[0].val.toExponential(2)}）。次へ進みます`); return false; }
		say(`${b}か所の変更で届くかを調べます（上限の計算ではまだ届く可能性あり. 余裕 ${lastF == null ? "-" : lastF.toExponential(2)}）`);
		for (const o of opt.slice(0, 3)) lams.push(o.lam);
		if (opt.length) prevLam = opt[0].lam;
		nL = lams.length;
		const tS = performance.now();
		topL = lams.map((lam) => topSums(lam, LVU));
		lneed = Float64Array.from(lams, (lam) => { let x = 0; for (let k = 0; k < K; k++) x += lam[k] * need[k]; return x; });
		levelLU = LV.map((list) => { const lu = new Float64Array(list.length * nL); list.forEach((v, vi) => { for (let l = 0; l < nL; l++) { let x = 0; const lam = lams[l]; for (let k = 0; k < K; k++) x += lam[k] * v.U[k]; lu[vi * nL + l] = x; } }); return lu; });
		stall("上限の表の作成", tS);
		return true;
	};
	const startTwoHand = weaponLocked ? isTwoHanded(baseWeapon) : false;
	// 1) 値段や中身の違いを見ず、性能で負けるものを全部捨てた軽い一覧で、何か所変えれば届くか（足し算の見込み）を先に調べる
	const feasLists = regionVariants.map((list) => {
		const plain = list.filter((v) => !v.pkg);
		const keep = paretoPrune(plain, need, { free: true });
		return [...keep, ...list.filter((v) => v.pkg)];
	});
	prepLists(feasLists);
	if (ax) say(`ASPD は足し算で見込まず、内訳（ASPD%を掛ける前 ${ax.a.toFixed(1)}・ASPD% ${ax.p}・固定 +${ax.f}）を持ち回って、らとりおの式 前+(200-前)×ASPD%+固定 で判定します`);
	say(`まず、値段や中身の違いを無視して、何か所変えれば届くかを調べます（候補 ${feasLists.map((l) => l.length).join("/")}件）`);
	feasMode = true;
	let firstBudget = n + 1;
	for (budget = 0; budget <= n; budget++) {
		const okLevel = await setupLevel(budget);
		if (!okLevel) continue;
		feasFound = false;
		await searchLevel();
		say(feasFound ? `${budget}か所で、足し算の見込み上は届く構成が見つかりました。ここから値段順に詰めます` : `${budget}か所では、枠まで含めて全部調べましたが届く構成はありませんでした`);
		if (feasFound) { firstBudget = budget; break; }
	}
	feasMode = false;
	await flush();
	emit(true);
	// 2) 届く最小の変更か所数から、全部の候補で、値段・カードの少なさの順に良いものを探す
	prepLists(regionVariants);
	say(`次に、全部の候補（${regionVariants.map((l) => l.length).join("/")}件）で、変更${firstBudget}か所から値段・カードの少なさの順に探します`);
	for (budget = firstBudget; budget <= n; budget++) {
		const okLevel = await setupLevel(budget);
		if (!okLevel) continue;
		await searchLevel();
		await flush();
		say(`${budget}か所の探索を終えました（実計算で確認した構成 ${foundCount}件、結果 ${results.length}件）`);
		if (finished()) break;
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

/** 値段が分からない物は、並べるときに値段の分かる物より後ろにする */
const UNKNOWN_PRICE = 1e12;

export class BfStopped extends Error {}

