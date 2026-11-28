/**
 * 計算用 Web Worker の束（bf-worker.js をCPUのコア数ぶん立てる）.
 * run(type, model) で空いている（待ちの少ない）Worker に計算を渡し、結果を Promise で返す。
 * Worker が使えない環境・初期化に失敗したときは available() が false になり、呼び出し側はこの画面のスレッドで計算する。
 */
let workers = null, failed = false, seq = 0, st = {}, crashes = 0;
// 探索の下準備（dfsBase / dfsLevel）の最新分。Worker を作り直したとき、同じ状態に戻すために持っておく
let lastBase = null, lastLevel = null, lastErr = "";
const pending = new Map(); // id → {resolve, reject, w}

/** 立てる Worker の数（論理コア数ぶん。画面のスレッドは待つだけで計算しないので、全コアを計算に使う。最低2・最大64） */
export function poolSize() {
	const n = navigator.hardwareConcurrency || 4;
	return Math.max(2, Math.min(64, n));
}
/** Worker が落ちたときの結果（待っていた仕事は、呼び出し側が別の Worker に出し直す） */
export class WorkerCrash extends Error {}
/** 直近の Worker のエラーの文面（画面に出す用） */
export function lastError() { return lastErr; }

function makeWorker(idx) {
	const w = new Worker(new URL("./bf-worker.js", import.meta.url), { type: "module" });
	w.busy = 0; w.idx = idx;
	w.onmessage = ({ data }) => {
		const p = pending.get(data.id);
		if (!p) return;
		pending.delete(data.id);
		w.busy--;
		if (data.err) p.reject(new Error(data.err));
		else { const v = data.v ?? data.t; if (v && typeof v === "object") v.lane = w.idx; p.resolve(v); }
	};
	// 1つの Worker が落ちても全部を捨てず、その Worker だけ作り直して、待っていた仕事は WorkerCrash で返す（全体が1スレッドに落ちるのを防ぐ）
	const crashed = (e) => {
		e.preventDefault?.();
		lastErr = `${e.message || e.type || "error"}${e.filename ? ` (${String(e.filename).split("/").pop()}:${e.lineno})` : ""}`;
		if (!workers || workers[w.idx] !== w) return;
		w.terminate();
		for (const [id, p] of pending) if (p.w === w) { pending.delete(id); p.reject(new WorkerCrash(lastErr)); }
		if (++crashes > 20) { fail(); return; }
		const nw = makeWorker(w.idx);
		workers[w.idx] = nw;
		if (lastBase) nw.postMessage({ id: 0, type: "dfsBase", model: lastBase });
		if (lastLevel) nw.postMessage({ id: 0, type: "dfsLevel", model: lastLevel });
	};
	w.onerror = crashed;
	w.onmessageerror = crashed;
	return w;
}
function start() {
	if (workers || failed) return;
	try {
		workers = [];
		for (let i = 0; i < poolSize(); i++) workers.push(makeWorker(i));
	} catch { fail(); }
}
function fail() {
	failed = true;
	for (const w of workers || []) w.terminate();
	workers = null;
	for (const p of pending.values()) p.reject(new Error("worker failed"));
	pending.clear();
}

/** 前に Worker が止まっていたら、次の検索で作り直せるようにする（止まったままだと、読み込み直すまでずっと1スレッドになる） */
export function retry() {
	failed = false; crashes = 0;
	// 検索のたびに、この端末の今の論理コア数に合わせて Worker の数を増減する（別のPCでも、そのPCの最大で動く）
	if (!workers) return;
	const want = poolSize();
	while (workers.length > want) { const w = workers.pop(); if (!w.busy) w.terminate(); else { w.terminate(); for (const [id, p] of pending) if (p.w === w) { pending.delete(id); p.reject(new WorkerCrash("縮小")); } } }
	while (workers.length < want) {
		const nw = makeWorker(workers.length);
		workers.push(nw);
		if (lastBase) nw.postMessage({ id: 0, type: "dfsBase", model: lastBase });
		if (lastLevel) nw.postMessage({ id: 0, type: "dfsLevel", model: lastLevel });
	}
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
	if (type === "dfsBase") lastBase = model;
	else if (type === "dfsLevel") lastLevel = model;
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
		{ const i = workers.indexOf(w); workers[i] = makeWorker(i); }
	}
}
export class CancelError extends Error {}
