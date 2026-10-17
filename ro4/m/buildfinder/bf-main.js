/** 計算画面の読み込みが終わってから装備シミュの画面を作る */
import { get as registryGet } from "../../../engine/runtime/engine-registry.js";
import { initBuildFinder } from "./bf-ui.js";
import { startDarkMode } from "./bf-dark.js";

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

// サイドバーの表記を BuildFinder に（サイドバーは後から作られるので出るまで待つ）
function rebrand(tries = 0) {
	const logo = document.querySelector("#sidebar .sidebar-logo");
	if (!logo) { if (tries < 50) setTimeout(() => rebrand(tries + 1), 200); return; }
	const mark = logo.querySelector("div");
	if (mark) mark.textContent = "BF";
	const title = logo.querySelector("h5");
	if (title) title.innerHTML = "RO BuildFinder<br>- 装備シミュレーター -";
}

const wait = () => (ready() ? (rebrand(), startDarkMode(), initBuildFinder(box)) : setTimeout(wait, 300));
wait();
