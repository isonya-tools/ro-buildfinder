/**
 * 計算用 Web Worker の束（bf-worker.js をCPUのコア数ぶん立てる）.
 * run(type, model) で空いている（待ちの少ない）Worker に計算を渡し、結果を Promise で返す。
 * Worker が使えない環境・初期化に失敗したときは available() が false になり、呼び出し側はこの画面のスレッドで計算する。
 */
let workers = null, failed = false, seq = 0, st = {};
const pending = new Map(); // id → {resolve, reject, w}

/** 立てる Worker の数（論理コア数−1、最低2・最大32） */
export function poolSize() {
	const n = (navigator.hardwareConcurrency || 4) - 1;
	return Math.max(2, Math.min(32, n));
}

function makeWorker() {
	const w = new Worker(new URL("./bf-worker.js", import.meta.url), { type: "module" });
	w.busy = 0;
	w.onmessage = ({ data }) => {
		const p = pending.get(data.id);
		if (!p) return;
		pending.delete(data.id);
		w.busy--;
		if (data.err) p.reject(new Error(data.err)); else p.resolve(data.v ?? data.t);
	};
	w.onerror = (e) => { e.preventDefault?.(); fail(); };
	return w;
}
function start() {
	if (workers || failed) return;
	try {
		workers = [];
		for (let i = 0; i < poolSize(); i++) workers.push(makeWorker());
	} catch { fail(); }
}
function fail() {
	failed = true;
	for (const w of workers || []) w.terminate();
	workers = null;
	for (const p of pending.values()) p.reject(new Error("worker failed"));
	pending.clear();
}

/** Worker で計算できるか */
export function available() { start(); return !!workers; }
/** Worker を使わないようにする（結果が画面側の計算と合わないときなど） */
export function disable() { fail(); }
/** 画面側の計算に合わせる内部状態（毎回の計算の前に Worker 側へ入れる） */
export function setState(s) { st = s; }

/** type: "core"（指標）| "skill"（スキルの固定詠唱・CT） */
export function run(type, model) {
	start();
	if (!workers) return Promise.reject(new Error("no worker"));
	let w = workers[0];
	for (const x of workers) if (x.busy < w.busy) w = x;
	const id = ++seq;
	w.busy++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject, w });
		try { w.postMessage({ id, type, model, st }); } catch (e) {
			// 渡せないデータだったときは、待ちの記録を残さない
			pending.delete(id);
			w.busy--;
			reject(e);
		}
	});
}

/** 全部の Worker に同じ内容を送る（返事は無い）。探索の下準備用 */
export function broadcast(type, model) {
	start();
	if (!workers) return;
	for (const w of workers) w.postMessage({ id: 0, type, model, st });
}

/** 待っている計算を全部取り消す（止めるボタン）。計算中の Worker は作り直す */
export function cancelAll() {
	if (!workers) return;
	const busy = new Set();
	for (const p of pending.values()) { busy.add(p.w); p.reject(new CancelError()); }
	pending.clear();
	for (const w of busy) {
		w.terminate();
		workers[workers.indexOf(w)] = makeWorker();
	}
}
export class CancelError extends Error {}
