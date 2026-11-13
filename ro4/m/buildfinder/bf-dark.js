/**
 * ダークモード化. ラトリオの画面は明るい背景色を CSS・属性・JS のインライン指定で持っているので、
 * 実際の色を見て、明るい背景は暗い色に、暗い文字は明るい色に置き換える（色味は残す）。
 */
const parse = (c) => {
	const m = c && c.match(/rgba?\(([^)]+)\)/);
	if (!m) return null;
	const [r, g, b, a = 1] = m[1].split(",").map((x) => parseFloat(x));
	return { r, g, b, a };
};
const lum = ({ r, g, b }) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const MARK = "bfDark";

function fixEl(el) {
	if (el.closest("#BF_ROOT, .bf-tip, .ts-dropdown, .ts-wrapper")) return;
	// 前回こちらで塗った色はいったん外して、今の本来の色を見る（状態で色が変わる欄のため）
	if (el.dataset[MARK]) { el.style.removeProperty("background-color"); el.style.removeProperty("color"); delete el.dataset[MARK]; }
	const cs = getComputedStyle(el);
	const bg = parse(cs.backgroundColor);
	if (bg && bg.a > 0.05 && lum(bg) > 0.55) {
		// 明るい背景 → 色味を残した暗い色
		const k = 0.22;
		el.style.setProperty("background-color", `rgb(${Math.round(bg.r * k + 20)}, ${Math.round(bg.g * k + 22)}, ${Math.round(bg.b * k + 28)})`, "important");
		el.dataset[MARK] = "1";
	}
	const fg = parse(cs.color);
	if (fg && lum(fg) < 0.45) {
		const max = Math.max(fg.r, fg.g, fg.b), min = Math.min(fg.r, fg.g, fg.b);
		if (max - min > 60) {
			// 色付き文字（赤・青など）は明るくする
			const s = 255 / Math.max(max, 1);
			el.style.setProperty("color", `rgb(${Math.min(255, Math.round(fg.r * s * 0.9 + 40))}, ${Math.min(255, Math.round(fg.g * s * 0.9 + 40))}, ${Math.min(255, Math.round(fg.b * s * 0.9 + 40))})`, "important");
		} else {
			el.style.setProperty("color", "#e4e6eb", "important");
		}
		el.dataset[MARK] = "1";
	}
}

const SKIP = new Set(["SCRIPT", "STYLE", "IMG", "CANVAS", "OPTION"]);
function fixTree(root) {
	if (root.nodeType !== 1 || SKIP.has(root.tagName)) return;
	fixEl(root);
	for (const el of root.querySelectorAll("*")) if (!SKIP.has(el.tagName)) fixEl(el);
}

// 変わった所だけまとめて直す
let queue = new Set(), pending = false;
function flush() {
	pending = false;
	const roots = [...queue];
	queue = new Set();
	for (const r of roots) if (r.isConnected) fixTree(r);
}

export function startDarkMode() {
	fixTree(document.body);
	new MutationObserver((list) => {
		for (const m of list) {
			if (m.type === "childList") m.addedNodes.forEach((n) => n.nodeType === 1 && queue.add(n));
			else queue.add(m.target);
		}
		if (!pending && queue.size) { pending = true; setTimeout(flush, 150); }
	}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "bgcolor"] });
}
