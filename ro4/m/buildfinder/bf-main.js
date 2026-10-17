/** 計算画面の読み込みが終わってから装備シミュの画面を作る */
import { get as registryGet } from "../../../engine/runtime/engine-registry.js";
import { initBuildFinder } from "./bf-ui.js";

function ready() {
	try {
		return typeof registryGet("extractModelFromDom") === "function"
			&& document.getElementById("OBJID_SELECT_JOB")?.options.length > 0
			&& registryGet("extractModelFromDom")();
	} catch {
		return false;
	}
}

const box = document.getElementById("BF_ROOT");
const wait = () => (ready() ? initBuildFinder(box) : setTimeout(wait, 300));
wait();
