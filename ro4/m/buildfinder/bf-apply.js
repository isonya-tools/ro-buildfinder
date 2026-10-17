/**
 * 検索結果の構成を、計算画面の「今の装備」に反映する.
 * 画面の状態からセーブデータを作り、変わった部位の装備・カード・エンチャだけ差し替えて読み込み直す。
 */
import { extractSaveModelFromState, buildSaveDataUnits } from "../../../engine/savedata/savedata-collect.js";
import { CSaveController } from "../../../engine/savedata/CSaveController.js";
import { get as registryGet } from "../../../engine/runtime/engine-registry.js";

// BF_REGIONS の key → セーブデータの装備欄の並び（右手, 左手, 頭上, 頭中, 頭下, 盾, 鎧, 肩, 靴, アクセ1, アクセ2）
const SAVE_INDEX = { weapon: 0, headTop: 2, headMid: 3, headUnder: 4, shield: 5, body: 6, shoulder: 7, shoes: 8, acc1: 9, acc2: 10 };

/**
 * @param {object} model 検索結果のモデル
 * @param {object[]} regions 反映する部位（BF_REGIONS の要素）
 */
export function applyModelToScreen(model, regions) {
	// 検索中の計算で内部の状態が別の構成になっているので、画面の入力で計算し直してから読み取る
	registryGet("calcCoreFromModel")(registryGet("extractModelFromDom")());
	const sm = extractSaveModelFromState();
	for (const r of regions) {
		if (r.shadow) {
			// シャドウ装備（カードは無く、エンチャ3つ）
			const sh = sm.equip.shadowRegions.find((x) => x.eqpRgnId === r.shadow);
			if (!sh) continue;
			const iid = model.shadowEquip?.itemId?.[r.shadow] || 0;
			if (sh.itemId !== iid) { sh.rndOpt = (sh.rndOpt || []).map(() => ({ kind: 0, value: 0 })); sh.itemId = iid; }
			sh.refine = model.shadowEquip?.refined?.[r.shadow] || 0;
			sh.cardIds = r.slots.slice(1).map((s) => model.card[s] || 0);
			continue;
		}
		const ent = sm.equip.itemRegions[SAVE_INDEX[r.key]];
		if (!ent) continue;
		if (ent.itemId !== model.equip[r.eq]) {
			// 装備が替わるときは、前の装備のランダムオプションを持ち越さない
			ent.rndOpt = ent.rndOpt.map(() => ({ kind: 0, value: 0 }));
			ent.itemId = model.equip[r.eq];
		}
		ent.cardIds = r.slots.map((s) => model.card[s] || 0);
		ent.cardCategoryIds = null;
	}
	const units = buildSaveDataUnits(sm);
	let text = "", bit = 0;
	for (const u of units) [text, bit] = u.encodeToURL(text, bit);
	CSaveController.loadFromURL(text);
}
