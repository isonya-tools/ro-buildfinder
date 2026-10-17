/**
 * 装備シミュで条件に使える指標の定義と、計算結果からの読み取り.
 * 値はラトリオの「アイテム情報」欄と同じところから読む。
 */
import { n_A_Kotei_Cast_Keigen } from "../../../engine/runtime/ro4-state.js";
import { g_VariableCastTimeRate } from "../../../engine/runtime/global.js";
import * as CI from "../../../engine/const/EnumCharaDataIndex.js";
import * as SP from "../../../engine/const/EnumItemSpId.js";

const ELM = ["無", "水", "地", "火", "風", "毒", "聖", "闇", "念", "不死"];
const RACE = ["無形", "不死", "動物", "植物", "昆虫", "魚貝", "悪魔", "人間", "天使", "竜"];
const SIZE = ["小型", "中型", "大型"];

/**
 * key: 指標キー, label: 表示名, group: 分類, unit: 単位, read(r, b): 計算結果から値を得る（b は戦闘計算の結果。スキル系のみ使う）
 * dir: 1 なら大きいほど良い、-1 なら小さいほど良い。battle: 戦闘計算（スキルの詠唱・CT）が必要な指標
 */
export const BF_METRICS = [];
const add = (key, label, group, unit, read, dir = 1, battle = false) => BF_METRICS.push({ key, label, group, unit, read, dir, battle });

add("maxhp", "MaxHP", "基本", "", (r) => r.charaData[CI.CHARA_DATA_INDEX_MAXHP]);
add("maxsp", "MaxSP", "基本", "", (r) => r.charaData[CI.CHARA_DATA_INDEX_MAXSP]);
add("aspd", "ASPD", "基本", "", (r) => Math.floor(r.charaData[CI.CHARA_DATA_INDEX_ASPD] * 10) / 10);
add("hit", "HIT", "基本", "", (r) => r.charaData[CI.CHARA_DATA_INDEX_HIT]);
add("flee", "FLEE", "基本", "", (r) => r.charaData[CI.CHARA_DATA_INDEX_FLEE]);
add("lucky", "完全回避", "基本", "", (r) => r.charaData[CI.CHARA_DATA_INDEX_LUCKY]);
add("cri", "クリティカル", "基本", "", (r) => r.charaData[CI.CHARA_DATA_INDEX_CRI]);

add("castVary", "変動詠唱 短縮", "詠唱・ディレイ", "%", () => Math.round((1 - g_VariableCastTimeRate) * 10000) / 100);
add("castFixed", "固定詠唱 短縮", "詠唱・ディレイ", "%", () => Math.round(n_A_Kotei_Cast_Keigen * 100) / 100);
add("delay", "ディレイ 短縮", "詠唱・ディレイ", "%", (r) => r.specData[SP.ITEM_SP_SKILL_DELAY_DOWN]);
const skillRes = (b) => b?.activeResultArray?.[0];
add("skCastFixed", "スキルの固定詠唱", "選んだスキル", "秒", (r, b) => round2(skillRes(b)?.castFixed ?? 0), -1, true);
add("skCastVary", "スキルの変動詠唱", "選んだスキル", "秒", (r, b) => round2(skillRes(b)?.castVary ?? 0), -1, true);
add("skCool", "スキルのCT", "選んだスキル", "秒", (r, b) => round2(skillRes(b)?.coolTime ?? 0), -1, true);
add("skDelay", "スキルのディレイ", "選んだスキル", "秒", (r, b) => round2(skillRes(b)?.delaySkill ?? 0), -1, true);

ELM.forEach((n, i) => add("resElm" + i, n + "属性 耐性", "属性耐性", "%", (r) => r.specData[SP.ITEM_SP_RESIST_ELM_VANITY + i]));
RACE.forEach((n, i) => add("resRace" + i, n + " 耐性", "種族耐性", "%", (r) => r.specData[SP.ITEM_SP_RESIST_RACE_SOLID + i]));
SIZE.forEach((n, i) => add("resSize" + i, n + " 耐性", "サイズ耐性", "%", (r) => r.specData[SP.ITEM_SP_RESIST_SIZE_SMALL + i]));
add("resBoss", "ボス 耐性", "その他の耐性", "%", (r) => r.specData[SP.ITEM_SP_RESIST_BOSS]);
add("resNotBoss", "一般 耐性", "その他の耐性", "%", (r) => r.specData[SP.ITEM_SP_RESIST_NOTBOSS]);
add("resLong", "遠距離 耐性", "その他の耐性", "%", (r) => r.specData[SP.ITEM_SP_RESIST_LONGRANGE]);
add("resPlayer", "プレイヤー 耐性", "その他の耐性", "%", (r) => r.specData[SP.ITEM_SP_RESIST_PLAYER_ALL]);

function round2(v) { return Math.round(v * 100) / 100; }

export const BF_METRIC_BY_KEY = Object.fromEntries(BF_METRICS.map((m) => [m.key, m]));

/** 計算結果から全指標を読む。r: calcCoreFromModel の戻り値、b: calcFromModel の戻り値（なければスキル系は 0） */
export function readMetrics(r, b = null) {
	const out = {};
	for (const m of BF_METRICS) {
		if (m.battle && !b) { out[m.key] = 0; continue; }
		const v = Number(m.read(r, b));
		out[m.key] = Number.isFinite(v) ? v : 0;
	}
	return out;
}
