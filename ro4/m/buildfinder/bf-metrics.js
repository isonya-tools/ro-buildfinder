/**
 * 装備シミュで条件に使える指標の定義と、計算結果からの読み取り.
 * 値はラトリオの「アイテム情報」欄と同じところから読む。
 */
import { n_A_Kotei_Cast_Keigen, n_tok_no_limit } from "../../../engine/runtime/ro4-state.js";
import { n_A_DEX, n_A_INT, n_CastCutForDisp, n_A_BodyZokusei, n_A_Equip, n_A_card } from "../../../engine/runtime/roro-state.js";
import { bfDelayReductionRaw } from "../../../engine/status/cast-delay.js";
import { ItemObjNew } from "../../../engine/equip/item.dat.js";
import { CardObjNew } from "../../../engine/equip/card.dat.js";
import * as CI from "../../../engine/const/EnumCharaDataIndex.js";
import * as SP from "../../../engine/const/EnumItemSpId.js";

const ELM = ["無", "水", "地", "火", "風", "毒", "聖", "闇", "念", "不死"];
const RACE = ["無形", "不死", "動物", "植物", "昆虫", "魚貝", "悪魔", "人間", "天使", "竜"];
const SIZE = ["小型", "中型", "大型"];
export const ELM_NAMES = ["無", "水", "地", "火", "風", "毒", "聖", "闇", "念", "不死"];

// 「リフレッシュ状態になる」効果を持つ装備・カード・セット効果（王家の栄光は別に数えるので除く）
const REFRESH_RE = /リフレッシュ\]?Lv\d*状態になる/;
const ROYAL_GLORY = 2123;
export const REFRESH_ITEMS = new Set(), REFRESH_CARDS = new Set();
for (const x of ItemObjNew) if (x && typeof x[10] === "string" && REFRESH_RE.test(x[10])) REFRESH_ITEMS.add(x[0]);
for (const c of CardObjNew) if (c && c[0] !== ROYAL_GLORY && typeof c[4] === "string" && REFRESH_RE.test(c[4])) REFRESH_CARDS.add(c[0]);
function refreshCount() {
	let n = 0;
	for (const id of n_A_Equip) if (REFRESH_ITEMS.has(id)) n++;
	for (const id of n_A_card) if (REFRESH_CARDS.has(id)) n++;
	return n;
}
const ABN = ["毒", "スタン", "凍結", "呪い", "暗闇", "睡眠", "沈黙", "混乱", "出血", "石化"];

/** key: 指標キー, label: 表示名, group: 分類, unit: 単位, read(r): 計算結果から値を得る。どれも大きいほど良い */
export const BF_METRICS = [];
export const BF_GROUPS = ["基本", "属性耐性", "状態異常耐性", "その他の耐性", "モンスター耐性"];
const add = (key, label, group, unit, read) => BF_METRICS.push({ key, label, group, unit, read, dir: 1 });

add("maxhp", "MaxHP", "基本", "", (r) => r.charaData[CI.CHARA_DATA_INDEX_MAXHP]);
add("maxsp", "MaxSP", "基本", "", (r) => r.charaData[CI.CHARA_DATA_INDEX_MAXSP]);
add("aspd", "ASPD", "基本", "", (r) => Math.floor(r.charaData[CI.CHARA_DATA_INDEX_ASPD] * 10) / 10);
add("hit", "HIT", "基本", "", (r) => r.charaData[CI.CHARA_DATA_INDEX_HIT]);
add("flee", "FLEE", "基本", "", (r) => r.charaData[CI.CHARA_DATA_INDEX_FLEE]);
add("lucky", "完全回避", "基本", "", (r) => r.charaData[CI.CHARA_DATA_INDEX_LUCKY]);
add("cri", "クリティカル", "基本", "", (r) => r.charaData[CI.CHARA_DATA_INDEX_CRI]);
add("castStat", "変動詠唱（INT/2+DEX）", "基本", "", () => Math.max(0, n_A_DEX) + Math.max(0, n_A_INT) / 2);
add("castGear", "変動詠唱（装備）", "基本", "%", () => 100 - n_CastCutForDisp);
add("castFixed", "固定詠唱 短縮", "基本", "%", () => Math.round(n_A_Kotei_Cast_Keigen * 100) / 100);
add("delay", "ディレイ 短縮", "基本", "%", () => bfDelayReductionRaw);
const sp = (r, ...ids) => ids.reduce((a, id) => a + (Number(r.specData[id]) || 0), 0);
add("ignDefN", "DEF無視（一般）", "基本", "%", (r) => sp(r, SP.ITEM_SP_IGNORE_DEF_ALL, SP.ITEM_SP_IGNORE_DEF_NOTBOSS, SP.ITEM_SP_IGNORE_DEF_RACE_ALL));
add("ignDefB", "DEF無視（ボス）", "基本", "%", (r) => sp(r, SP.ITEM_SP_IGNORE_DEF_ALL, SP.ITEM_SP_IGNORE_DEF_BOSS, SP.ITEM_SP_IGNORE_DEF_RACE_ALL));
add("ignMdefN", "MDEF無視（一般）", "基本", "%", (r) => sp(r, SP.ITEM_SP_IGNORE_MDEF_ALL, SP.ITEM_SP_IGNORE_MDEF_NOTBOSS, SP.ITEM_SP_IGNORE_MDEF_RACE_ALL));
add("ignMdefB", "MDEF無視（ボス）", "基本", "%", (r) => sp(r, SP.ITEM_SP_IGNORE_MDEF_ALL, SP.ITEM_SP_IGNORE_MDEF_BOSS, SP.ITEM_SP_IGNORE_MDEF_RACE_ALL));
add("kiri", "錐効果", "基本", "", (r) => sp(r, SP.ITEM_SP_KIRI_EFFECT) > 0 ? 1 : 0);
BF_METRICS[BF_METRICS.length - 1].kind = "bool";
add("noCancel", "詠唱妨害不可", "基本", "", (r) => sp(r, SP.ITEM_SP_NEVER_CAST_CANCEL) > 0 ? 1 : 0);
BF_METRICS[BF_METRICS.length - 1].kind = "bool";
add("perfect", "必中", "基本", "%", (r) => sp(r, SP.ITEM_SP_PERFECT_ATTACK_UP));
add("refresh", "リフレ状態", "基本", "個", () => refreshCount());
add("bodyElm", "鎧の属性", "基本", "", () => n_A_BodyZokusei);
BF_METRICS[BF_METRICS.length - 1].kind = "elm";

// 耐性は計算上95%で切られるが、相手のデバフで下がる分も見込めるように、切る前の値で比べる
ELM.forEach((n, i) => add("resElm" + i, n + "属性", "属性耐性", "%", () => n_tok_no_limit[SP.ITEM_SP_RESIST_ELM_VANITY + i]));
ABN.forEach((n, i) => add("resAbn" + i, n, "状態異常耐性", "%", () => n_tok_no_limit[SP.ITEM_SP_RESIST_STATE_POISON + i]));
add("resBoss", "ボス", "その他の耐性", "%", () => n_tok_no_limit[SP.ITEM_SP_RESIST_BOSS]);
add("resNotBoss", "一般", "その他の耐性", "%", () => n_tok_no_limit[SP.ITEM_SP_RESIST_NOTBOSS]);
add("resLong", "遠距離", "その他の耐性", "%", () => n_tok_no_limit[SP.ITEM_SP_RESIST_LONGRANGE]);
add("resPlayer", "プレイヤー", "その他の耐性", "%", () => n_tok_no_limit[SP.ITEM_SP_RESIST_PLAYER_ALL]);
RACE.forEach((n, i) => add("resRace" + i, n, "モンスター耐性", "%", () => n_tok_no_limit[SP.ITEM_SP_RESIST_RACE_SOLID + i]));
SIZE.forEach((n, i) => add("resSize" + i, n, "モンスター耐性", "%", () => n_tok_no_limit[SP.ITEM_SP_RESIST_SIZE_SMALL + i]));

export const BF_METRIC_BY_KEY = Object.fromEntries(BF_METRICS.map((m) => [m.key, m]));

/** 計算結果（calcCoreFromModel / calcFromModel の戻り値）から全指標を読む */
export function readMetrics(r) {
	const out = {};
	for (const m of BF_METRICS) {
		const v = Number(m.read(r));
		out[m.key] = Number.isFinite(v) ? v : 0;
	}
	return out;
}
