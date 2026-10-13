/* Tiny dependency-free SVG chart helpers tuned for the mobile card layout. */
const CSSV = getComputedStyle(document.documentElement);
const cVar = (n) => (CSSV.getPropertyValue(n) || "").trim();

function el(tag, attrs = {}) {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

/** Multi-series area/line chart. series: [{points: [{x, y}], color, area, dash}] */
export function lineChart(container, series, opts = {}) {
  const W = opts.w || 340, H = opts.h || 150;
  container.classList.add("chart-box");
  container.innerHTML = "";
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}` });
  const all = series.flatMap((s) => s.points);
  if (all.length < 2) {
    svg.appendChild(Object.assign(el("text", { x: W / 2, y: H / 2, "text-anchor": "middle", fill: cVar("--faint"), "font-size": 11 }), { textContent: "" }));
    container.appendChild(svg);
    return;
  }
  const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMax = opts.yMax ?? Math.max(...ys, 1);
  const px = (x) => ((x - xMin) / Math.max(xMax - xMin, 0.001)) * (W - 8) + 4;
  const py = (y) => H - 16 - (y / yMax) * (H - 26);
  const yTicks = 3;
  for (let i = 0; i <= yTicks; i++) {
    const v = (yMax / yTicks) * i;
    svg.appendChild(el("line", { x1: 4, y1: py(v), x2: W - 4, y2: py(v), stroke: "rgba(140,170,220,.10)", "stroke-width": 1 }));
    const t = el("text", { x: W - 2, y: py(v) - 2, fill: cVar("--faint"), "font-size": 8.5, "text-anchor": "end" });
    t.textContent = v >= 10 ? Math.round(v) : v.toFixed(1);
    svg.appendChild(t);
  }
  for (const s of series) {
    if (!s.points.length) continue;
    const d = s.points.map((p, i) => `${i ? "L" : "M"}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");
    if (s.area) {
      const a = d + ` L${px(s.points[s.points.length - 1].x).toFixed(1)},${py(0).toFixed(1)} L${px(s.points[0].x).toFixed(1)},${py(0).toFixed(1)} Z`;
      svg.appendChild(el("path", { d: a, fill: s.color, opacity: 0.13, stroke: "none" }));
    }
    const p = el("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" });
    if (s.dash) p.setAttribute("stroke-dasharray", s.dash);
    svg.appendChild(p);
  }
  if (opts.xLabels) {
    for (const [x, label] of opts.xLabels) {
      const t = el("text", { x: px(x), y: H - 4, fill: cVar("--faint"), "font-size": 8.5, "text-anchor": "middle" });
      t.textContent = label;
      svg.appendChild(t);
    }
  }
  container.appendChild(svg);
}

/** Simple bar chart. bars: [{label, value, color}] */
export function barChart(container, bars, opts = {}) {
  const W = opts.w || 340, H = opts.h || 130;
  container.classList.add("chart-box");
  container.innerHTML = "";
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}` });
  const max = Math.max(...bars.map((b) => b.value), 0.001);
  const n = bars.length || 1;
  const gap = Math.min(14, (W / n) * 0.35);
  const bw = (W - 8 - gap * (n - 1)) / Math.max(n, 1);
  bars.forEach((b, i) => {
    const x = 4 + i * (bw + gap);
    const h = (b.value / max) * (H - 30);
    const y = H - 20 - h;
    if (b.value > 0) svg.appendChild(el("rect", { x, y, width: bw, height: Math.max(h, 1), rx: 4, fill: b.color || cVar("--sky") }));
    if (b.value > 0 && b.showVal !== false) {
      const t = el("text", { x: x + bw / 2, y: y - 4, fill: cVar("--muted"), "font-size": 8, "text-anchor": "middle" });
      t.textContent = opts.valFmt ? opts.valFmt(b.value) : Math.round(b.value);
      svg.appendChild(t);
    }
    const t = el("text", { x: x + bw / 2, y: H - 6, fill: cVar("--faint"), "font-size": 8.5, "text-anchor": "middle" });
    t.textContent = b.label;
    svg.appendChild(t);
  });
  container.appendChild(svg);
}

/** Radial SOC gauge, 0..100. */
export function gauge(container, pct, { label = "", sub = "", color } = {}) {
  const W = 110, H = 110;
  container.innerHTML = "";
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, style: "width:104px;height:104px" });
  const cx = W / 2, cy = H / 2, r = 44, sw = 10;
  const cir = 2 * Math.PI * r;
  svg.appendChild(el("circle", { cx, cy, r, fill: "none", stroke: "rgba(140,170,220,.13)", "stroke-width": sw }));
  const col = color || (pct <= 25 ? cVar("--red") : pct <= 45 ? cVar("--amber") : cVar("--green"));
  svg.appendChild(el("circle", { cx, cy, r, fill: "none", stroke: col, "stroke-width": sw, "stroke-linecap": "round",
    "stroke-dasharray": `${(pct / 100) * cir} ${cir}`, transform: `rotate(-90 ${cx} ${cy})` }));
  const t1 = el("text", { x: cx, y: cy + 1, fill: cVar("--text"), "font-size": 22, "font-weight": 800, "text-anchor": "middle" });
  t1.textContent = Math.round(pct) + "%";
  const t2 = el("text", { x: cx, y: cy + 18, fill: cVar("--faint"), "font-size": 9, "text-anchor": "middle" });
  t2.textContent = label;
  svg.appendChild(t1); svg.appendChild(t2);
  container.appendChild(svg);
  if (sub) {
    const d = document.createElement("div");
    d.innerHTML = sub;
    container.appendChild(d);
  }
}

/** Horizontal mini-bar list (labels left, values right). */
export function hbars(container, rows) {
  container.innerHTML = "";
  for (const r of rows) {
    const row = document.createElement("div");
    row.style.cssText = "margin-bottom:9px";
    row.innerHTML = `<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
      <span>${r.label}</span><b style="color:${r.color || "var(--text)"}">${r.valueText ?? r.value}</b></div>`;
    const p = document.createElement("div");
    p.className = "progress";
    p.innerHTML = `<i style="width:${Math.min(100, r.pct)}%;background:${r.color || "var(--green)"}"></i>`;
    row.appendChild(p);
    container.appendChild(row);
  }
}
