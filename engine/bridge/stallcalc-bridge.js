/**
 * stallcalc.js の公開関数への軽量ブリッジ（依存ゼロ・C-6 後半）.
 *
 * stallcalc.js を直接 import すると循環・vitest ハングを引き起こすため（reference.md 参照）、
 * 外部ファイルは本モジュールの委譲ラッパーを import して呼び出す。
 * 実体は stallcalc.js がモジュール評価時に __registerFootFunctions() で登録する。
 * 未登録環境（pages/ ページ・ユニットテスト）では各ラッパーは no-op（undefined を返す）。
 */

const _reg = {};

/** stallcalc.js がモジュール評価時に実体を登録する */
export function __registerFootFunctions(fns) {
	Object.assign(_reg, fns);
}

export function RefreshSuperNoviceFullWeapon(...a) { return _reg.RefreshSuperNoviceFullWeapon?.(...a); }
export function GetCastScalingOfSkillForCastTimeVary(...a) { return _reg.GetCastScalingOfSkillForCastTimeVary?.(...a); }
export function GetCastFixOfSkillForCastTimeVary(...a) { return _reg.GetCastFixOfSkillForCastTimeVary?.(...a); }
export function GetCastScalingOfSkillForCastTimeFixed(...a) { return _reg.GetCastScalingOfSkillForCastTimeFixed?.(...a); }
export function GetCastFixOfSkillForCastTimeFixed(...a) { return _reg.GetCastFixOfSkillForCastTimeFixed?.(...a); }
export function GetAdditionalFixedCastTime(...a) { return _reg.GetAdditionalFixedCastTime?.(...a); }
export function GetCastScalingOfSkillForCastTimeForce(...a) { return _reg.GetCastScalingOfSkillForCastTimeForce?.(...a); }
export function GetCastFixOfSkillForCastTimeForce(...a) { return _reg.GetCastFixOfSkillForCastTimeForce?.(...a); }
export function GetCoolFixOfSkill(...a) { return _reg.GetCoolFixOfSkill?.(...a); }
export function GetCostScalingOfSkill(...a) { return _reg.GetCostScalingOfSkill?.(...a); }
export function GetCostFixOfSkill(...a) { return _reg.GetCostFixOfSkill?.(...a); }
export function GetEquippedTotalSPEquip(...a) { return _reg.GetEquippedTotalSPEquip?.(...a); }
export function GetEquippedSPListEquip(...a) { return _reg.GetEquippedSPListEquip?.(...a); }
export function GetEquippedSPValueArrayEquip(...a) { return _reg.GetEquippedSPValueArrayEquip?.(...a); }
export function GetEquippedTotalSPCardAndElse(...a) { return _reg.GetEquippedTotalSPCardAndElse?.(...a); }
export function GetEquippedSPListCardAndElse(...a) { return _reg.GetEquippedSPListCardAndElse?.(...a); }
export function GetEquippedSPValueArrayCardAndElse(...a) { return _reg.GetEquippedSPValueArrayCardAndElse?.(...a); }
export function GetEquippedTotalSPArrow(...a) { return _reg.GetEquippedTotalSPArrow?.(...a); }
export function IsMatchSpDefId(...a) { return _reg.IsMatchSpDefId?.(...a); }
export function CheckSpDefFriendlyOver(...a) { return _reg.CheckSpDefFriendlyOver?.(...a); }
export function CheckSpDefBaseLvOver(...a) { return _reg.CheckSpDefBaseLvOver?.(...a); }
export function CheckSpDefJobRestrict(...a) { return _reg.CheckSpDefJobRestrict?.(...a); }
export function CheckSpDefPureStatus(...a) { return _reg.CheckSpDefPureStatus?.(...a); }
export function CheckSpDefRefineOver(...a) { return _reg.CheckSpDefRefineOver?.(...a); }
export function InitJobInfo(...a) { return _reg.InitJobInfo?.(...a); }
export function NumSearch(...a) { return _reg.NumSearch?.(...a); }
export function NumSearch2(...a) { return _reg.NumSearch2?.(...a); }
export function EquipNumSearchFurubitaHead(...a) { return _reg.EquipNumSearchFurubitaHead?.(...a); }
export function EquipNumSearchFurubitaSet(...a) { return _reg.EquipNumSearchFurubitaSet?.(...a); }
export function ROUNDDOWN(...a) { return _reg.ROUNDDOWN?.(...a); }
export function Init(...a) { return _reg.Init?.(...a); }
// 画面の読み込み中など、全計算を何度も走らせたくないとき用。止めている間の呼び出しは直前の結果を返し、
// 解除時に1回だけ計算し直す（読み込み中の後ろの処理が計算結果を読むので、最初の1回だけは通す）
let _deferStAllCalc = false, _pendingStAllCalc = false, _firstStAllCalc = false, _lastStAllCalc;
export function deferStAllCalc(on) {
	_deferStAllCalc = !!on;
	_firstStAllCalc = !!on;
	if (!on && _pendingStAllCalc) { _pendingStAllCalc = false; return _lastStAllCalc = _reg.StAllCalc?.(); }
}
export function StAllCalc(...a) {
	if (_deferStAllCalc) {
		if (_firstStAllCalc) _firstStAllCalc = false;
		else { _pendingStAllCalc = true; return _lastStAllCalc; }
	}
	return _lastStAllCalc = _reg.StAllCalc?.(...a);
}
