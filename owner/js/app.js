/* ============================================================
   Silent Assassins — app shell + views
   Tabs: Home, Ports, Energy, Alerts, AI. Settings in the header.
   ============================================================ */
import { Station, CFG, pvPotential } from "./engine.js";
import { lineChart, barChart, gauge, hbars } from "./charts.js";
import { local, hashPin } from "./store.js";
import { getAiConfig, setAiConfig, listModels, testConnection, autoDetect, builtinAnswer, chat, buildSystemPrompt, DEFAULT_AI } from "./ai.js";

const $ = (sel, root = document) => root.querySelector(sel);
const app = () => $("#app");
const fmt = (n, d = 1) => (n == null || isNaN(n) ? "—" : (+n).toFixed(d));
const money = (n) => "₹" + Math.round(n).toLocaleString("en-IN");

let station = null;
let route = "home";
let uiTimer = null;
let engineTimer = null;
let deferredPrompt = null;
let chatState = local.get("chat", []);
let chatAbort = null;
let aiBusy = false;

/* ------------------------------------------------ boot */
function boot() {
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredPrompt = e; showInstallBanner(); });

  const profile = local.get("profile", null);
  if (!profile || !profile.pinHash) { renderSetup(); return; }
  renderLock();
}
document.addEventListener("DOMContentLoaded", boot);

/* ------------------------------------------------ setup (first run) */
function renderSetup() {
  app().innerHTML = `
    <div class="lock-screen">
      <img class="lock-logo" src="./icons/icon-512.png" alt="" />
      <div class="lock-title">Welcome, Station Owner</div>
      <div class="lock-sub">Set up your Silent Assassins owner app. Your data stays on this phone.</div>
      <div class="setup-card">
        <div class="field"><label>Station name</label>
          <input id="su-name" value="My Solar Charging Hub" maxlength="40" /></div>
        <div class="field"><label>New owner PIN (4–6 digits)</label>
          <input id="su-pin" inputmode="numeric" type="password" maxlength="6" placeholder="••••" /></div>
        <div class="field"><label>Confirm PIN</label>
          <input id="su-pin2" inputmode="numeric" type="password" maxlength="6" placeholder="••••" /></div>
        <button class="btn primary block" id="su-go">Create owner app</button>
        <div class="hint">The PIN protects your station data if someone borrows your phone. Demo telemetry starts instantly; connect a real controller later in Settings.</div>
      </div>
    </div>`;
  $("#su-go").onclick = () => {
    const name = $("#su-name").value.trim() || "My Solar Charging Hub";
    const pin = $("#su-pin").value.trim();
    const pin2 = $("#su-pin2").value.trim();
    const err = (m) => { $(".setup-card .hint").textContent = m; $(".setup-card .hint").style.color = "var(--red)"; };
    if (!/^\d{4,6}$/.test(pin)) return err("PIN must be 4–6 digits.");
    if (pin !== pin2) return err("PINs do not match.");
    station = new Station();
    persistStation();
    local.set("profile", { name, pinHash: hashPin(pin), pinLen: pin.length, created: Date.now() });
    startShell();
  };
}

/* ------------------------------------------------ PIN lock */
let pinBuf = "";
function renderLock() {
  app().innerHTML = `
    <div class="lock-screen">
      <img class="lock-logo" src="./icons/icon-512.png" alt="" />
      <div class="lock-title">Silent Assassins</div>
      <div class="lock-sub">${(local.get("profile", {}).name || "")} — enter owner PIN</div>
      <div class="pin-dots" id="dots"></div>
      <div class="pin-error" id="pin-err"></div>
      <div class="pin-pad" id="pad"></div>
    </div>`;
  drawDots();
  const pad = $("#pad");
  "123456789⌫0".split("").forEach((k) => {
    const b = document.createElement("button");
    b.className = "pin-key" + (k === "⌫" ? " action" : "");
    b.textContent = k;
    b.onclick = () => {
      if (k === "⌫") pinBuf = pinBuf.slice(0, -1);
      else if (pinBuf.length < 6) pinBuf += k;
      drawDots();
      const need = local.get("profile", {}).pinLen || 4;
      if (pinBuf.length === need) tryUnlock();
    };
    pad.appendChild(b);
  });
}
function drawDots() {
  const dots = $("#dots");
  if (!dots) return;
  const len = Math.max(pinBuf.length, 1);
  dots.innerHTML = "";
  for (let i = 0; i < Math.max(4, pinBuf.length); i++) {
    dots.insertAdjacentHTML("beforeend", `<div class="pin-dot ${i < pinBuf.length ? "filled" : ""}"></div>`);
  }
}
function tryUnlock() {
  const p = local.get("profile", {});
  if (hashPin(pinBuf) === p.pinHash) { pinBuf = ""; startShell(); }
  else {
    $("#pin-err").textContent = "Wrong PIN — try again.";
    document.querySelectorAll("#dots .pin-dot").forEach((d) => d.classList.add("error"));
    setTimeout(() => { pinBuf = ""; renderLock(); }, 600);
  }
}

/* ------------------------------------------------ shell */
function startShell() {
  if (!station) station = new Station();
  restoreStation();
  app().innerHTML = `
    <div class="shell on" id="shell">
      <header class="header">
        <div class="header-row">
          <h1 id="h-title">Silent Assassins</h1>
          <button class="icon-btn" id="b-lock" title="Lock app" aria-label="Lock app"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3"/></svg></button>
          <button class="icon-btn" id="b-set" title="Settings" aria-label="Settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M16 4v4M10 10v4M18 16v4"/></svg></button>
        </div>
        <div class="chips" id="h-chips"></div>
      </header>
      <main class="content" id="view"></main>
      <nav class="tabbar" id="tabbar"></nav>
      <div class="toast" id="toast"></div>
    </div>`;
  $("#b-lock").onclick = () => { persistStation(); pinBuf = ""; renderLock(); };
  $("#b-set").onclick = () => go("settings");
  window.addEventListener("hashchange", () => {
    const h = location.hash.replace("#", "");
    if (["home", "ports", "energy", "alerts", "ai", "settings"].includes(h) && h !== route) go(h);
  });

  // engine loop: drive sim minutes from real time
  let acc = 0, last = performance.now();
  engineTimer = setInterval(() => {
    const now = performance.now();
    const dt = Math.min(5, (now - last) / 1000); last = now;
    if (!station.paused) {
      acc += dt * station.speed;
      const mins = Math.floor(acc);
      if (mins > 0) { station.tick(mins); acc -= mins; persistThrottled(); }
    }
  }, 1000);

  bindTabbar();
  go((location.hash || "#home").replace("#", "") || "home");
  refreshLoop();
}

function toast(msg) {
  const t = $("#toast"); if (!t) return;
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2200);
}

const TABS = [
  { id: "home", icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 5 13h6l-1 9 8-11h-6z"/></svg>', label: "Station" },
  { id: "ports", icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/></svg>', label: "Ports" },
  { id: "energy", icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-8M2 20h20"/></svg>', label: "Energy" },
  { id: "alerts", icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 21h4"/></svg>', label: "Alerts" },
  { id: "ai", icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>', label: "Assistant" },
];
function bindTabbar() {
  const bar = $("#tabbar"); if (!bar) return;
  bar.innerHTML = TABS.map((t) => `
    <span class="tab-anch">
      <button data-tab="${t.id}"><span class="t-ico">${t.icon}</span>${t.label}</button>
      <span class="t-badge" id="badge-${t.id}" style="display:none"></span>
    </span>`).join("") + `
    <button data-tab="settings" style="display:flex" id="tab-settings"><span class="t-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M16 4v4M10 10v4M18 16v4"/></svg></span>Settings</button>`;
  bar.querySelectorAll("button[data-tab]").forEach((b) => {
    b.onclick = () => go(b.dataset.tab);
  });
}

function go(r) {
  route = r;
  history.replaceState(null, "", "#" + r);
  document.querySelectorAll("#tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === r));
  const titles = { home: "Station", ports: "Ports & control", energy: "Energy & revenue", alerts: "Alarms & events", ai: "AI Assistant", settings: "Settings" };
  $("#h-title").textContent = titles[r] || "Silent Assassins";
  paint();
  window.scrollTo(0, 0);
}

/* refresh visible view ~every 2s */
function refreshLoop() {
  clearInterval(uiTimer);
  uiTimer = setInterval(() => {
    if (route !== "ai" && local.get("profile", null)) paintChips();
    const seen = local.get("alertsSeen", 0);
    const unseen = station.alarms.filter((a) => a._id > seen).length;
    const badge = $("#badge-alerts");
    if (badge) {
      badge.style.display = unseen > 0 ? "grid" : "none"; badge.textContent = Math.min(unseen, 99);
    }
    if (route !== "ai" && route !== "settings") paint();
  }, 2000);
}

/* ------------------------------------------------ persistence */
function persistStation() {
  if (!station) return;
  local.set("station", {
    socPct: station.socPct, backupOn: station.backupOn, tempC: station.tempC,
    minOfDay: station.minOfDay, day: station.day, speed: station.speed,
    revenuePrice: station.revenuePrice, paused: station.paused,
    days: station.days, alarms: station.alarms.slice(0, 60),
  });
}
let persistCount = 0;
function persistThrottled() {
  if (++persistCount % 15 === 0) persistStation();
}
function restoreStation() {
  const s = local.get("station", null);
  if (!s) { station = new Station(); persistStation(); return; }
  Object.assign(station, s);
  station.history = [];
  station.ports = Array.from({ length: CFG.PORTS }, (_, i) => station.newPort(i));
}

/* ------------------------------------------------ header chips + views */
function paintChips() {
  if (station.history.length === 0) return;
  const live = station.history[station.history.length - 1];
  const crit = station.alarms[0] && station.alarms[0].sev === "crit";
  $("#h-chips").innerHTML = `
    <span class="chip green"><span class="dot"></span>Solar <b>${fmt(pvPotential(station.hourFloat(), station._cloud || 0.2))} kW</b></span>
    <span class="chip sky"><span class="dot"></span>Load <b>${fmt(live.load)} kW</b></span>
    <span class="chip ${station.backupOn ? "amber" : ""}"><span class="dot ${station.backupOn ? "blink" : ""}"></span>Battery <b>${Math.round(station.socPct)}%</b></span>
    <span class="chip ${station.backupOn ? "amber" : ""}">Backup <b>${station.backupOn ? "ON" : "off"}</b></span>
    ${crit ? '<span class="chip red"><span class="dot blink"></span>Alarm</span>' : ""}
    <span class="chip">Day <b>${station.day}</b> · ${station.stamp()}</span>`;
}
let column = false; // unused flag guard

/* ------------------------------------------------ views */
function paint() {
  paintChips();
  const v = $("#view");
  if (!v) return;
  if (route === "home") viewHome(v);
  else if (route === "ports") viewPorts(v);
  else if (route === "energy") viewEnergy(v);
  else if (route === "alerts") viewAlerts(v);
  else if (route === "ai") viewAI(v);
  else if (route === "settings") viewSettings(v);
}

/* -------- HOME -------- */
function viewHome(v) {
  const live = station.history[station.history.length - 1] || { solar: pvPotential(station.hourFloat(), station._cloud || 0.2), load: 0, soc: station.socPct, budget: 0 };
  const plugged = station.ports.filter((p) => p.state !== "off");
  const charging = plugged.filter((p) => p.measured > 0.01).length;
  const today = plugged.reduce((s, p) => s + p.deliveredKwhDay, 0) + 0;
  const revenue = today * station.revenuePrice;
  v.innerHTML = `
    <div class="card">
      <div class="grid2">
        <div><div class="hero-num">${fmt(today)}<small> kWh</small></div>
          <div class="hint">sold today · est. ${money(revenue)}</div></div>
        <div id="gauge"></div>
      </div>
    </div>
    <div class="grid2" style="grid-column:auto">
      <div class="stat green"><div class="s-label">Solar now</div><div class="s-val">${fmt(pvPotential(station.hourFloat(), station._cloud || 0.2))}<span class="s-unit">kW</span></div></div>
      <div class="stat sky"><div class="s-label">Vehicles</div><div class="s-val">${charging}<span class="s-unit">charging · ${plugged.length - charging} waiting</span></div></div>
      <div class="stat amber"><div class="s-label">Power budget</div><div class="s-val">${fmt(live.budget)}<span class="s-unit">kW</span></div></div>
      <div class="stat purple"><div class="s-label">Backup feed</div><div class="s-val" style="font-size:16px;padding-top:6px">${station.backupOn ? "ON · 3 kW" : "Off"}<span class="s-unit">${station.backupOn ? "" : "grid idle"}</span></div></div>
    </div>
    <div class="card"><h2>Power — last 6 h</h2><div id="chart-day"></div>
      <div class="legend">
        <span><i style="background:var(--green)"></i>Solar</span>
        <span><i style="background:var(--sky)"></i>Charging load</span>
        <span><i style="background:var(--amber)"></i>Budget</span>
      </div></div>
    <div class="card">
      <h2>Controller status</h2>
      <div class="set-row"><div><div class="sr-label">Fair share active</div><div class="sr-sub">Weighted max-min with guaranteed minimums · cuts instant · raises ramped 0.5 kW/min</div></div><span class="chip green"><span class="dot"></span>1 s loop</span></div>
      <div class="set-row"><div><div class="sr-label">Battery reserve</div><div class="sr-sub">Floor 20% · backup engages ≤30%, releases ≥45%</div></div><span class="chip ${station.socPct <= 30 ? "amber" : "green"}"><b>${Math.round(station.socPct)}%</b></span></div>
      <div class="set-row"><div><div class="sr-label">Converter temperature</div><div class="sr-sub">Derates above 70 °C</div></div><span class="chip ${station.tempC > 65 ? "amber" : "green"}"><b>${Math.round(station.tempC)} °C</b></span></div>
    </div>
    <div class="card">
      <h2>Try live control</h2>
      <div class="btn-row">
        <button class="btn small" id="q-arrive">Vehicle arrives</button>
        <button class="btn small" id="q-prio">Priority user</button>
        <button class="btn small" id="q-cloud">Cloud front</button>
        <button class="btn small" id="q-batt">Drain battery</button>
      </div>
      <div class="hint" style="margin-top:8px">Watch ports share the budget on the Ports tab. The controller re-shares instantly.</div>
    </div>`;
  gauge($("#gauge"), station.socPct, { label: "battery" });
  drawDayChart($("#chart-day"), 360);
  $("#q-arrive").onclick = () => { const p = station.addWaiting(false); if (p) toast(`Vehicle on port ${p.id}`); };
  $("#q-prio").onclick = () => { const p = station.addWaiting(true); if (p) toast("Priority user admitted"); };
  $("#q-cloud").onclick = () => { station.fault("cloud"); toast("Cloud front passing…"); };
  $("#q-batt").onclick = () => { station.fault("battery"); toast("Battery drains to a low state"); };
}

function drawDayChart(box, minutesBack) {
  const rows = station.history.slice(-minutesBack);
  if (!rows.length) return;
  const x0 = rows[0].min + (rows[0].day - station.day) * 1440;
  const mk = (key) => rows.map((r) => ({ x: r.min + (r.day - station.day) * 1440, y: r[key] }));
  lineChart(box, [
    { points: mk("solar"), color: getComputedStyle(document.documentElement).getPropertyValue("--green").trim() || "#3ddc84", area: true },
    { points: mk("load"), color: getComputedStyle(document.documentElement).getPropertyValue("--sky").trim() || "#55b3ff" },
    { points: mk("budget"), color: getComputedStyle(document.documentElement).getPropertyValue("--amber").trim() || "#ffc43d", dash: "4 4" },
  ], { yMax: CFG.CONVERTER_KW, xLabels: [[x0, station.stamp()]] });
}

/* -------- PORTS -------- */
function viewPorts(v) {
  const waiting = station.waitingEstimate();
  v.innerHTML = `
    <div class="card">
      <div class="speed-row">
        <span class="hint" style="flex:1">Estimated wait for the next arrival: <b style="color:var(--amber)">${fmt(waiting, 0)} min</b></span>
      </div>
    </div>
    <div id="port-list">
      ${station.ports.map((p) => portCard(p, !portDetailOpen ? "" : (portDetailOpen === p.id ? "open" : ""))).join("")}
    </div>
    <div class="card">
      <h2>Inject a field fault</h2>
      <div class="btn-row">
        ${station.ports.filter((x) => x.state !== "off").slice(0, 4).map((p) => `<button class="btn small danger" data-over="${p.id}">Port ${p.id} overdraw</button>`).join("") || '<span class="hint">No active ports right now.</span>'}
        <button class="btn small amber" id="f-thermal">Overtemp</button>
      </div>
      <div class="hint" style="margin-top:8px">Overdraw opens the port relay, exactly like field firmware: that port is isolated, the rest keep charging.</div>
    </div>`;
  v.querySelectorAll("[data-over]").forEach((b) => { b.onclick = () => { station.fault("overdraw", +b.dataset.over); paint(); toast("Relay opened on port " + b.dataset.over); }; });
  const ft = $("#f-thermal"); if (ft) ft.onclick = () => { station.fault("thermal"); paint(); toast("Converter heating above 70 °C"); };
  v.querySelectorAll(".port-card").forEach((c) => {
    c.onclick = () => { portDetailOpen = portDetailOpen === +c.dataset.pid ? 0 : +c.dataset.pid; paint(); };
  });
  // per-port unplug buttons inside open card
  v.querySelectorAll("[data-unplug]").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); station.unplug(+b.dataset.unplug); portDetailOpen = 0; paint(); };
  });
}
let portDetailOpen = 0;
function portCard(p) {
  const stCls = { off: "off", wait: "wait", charge: "charge", full: "full", fault: "fault" }[p.state] || "off";
  const stTxt = { off: "Empty", wait: "Waiting", charge: "Charging", full: "Full / done", fault: "Relay open (fault)" }[p.state];
  const info = p.vehicle ? `${p.vehicle.type}${p.vehicle.prio ? " · PRIORITY" : ""}` : "—";
  const detail = portDetailOpen === p.id ? `
    <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line)">
      <div style="display:flex;gap:8px;margin-bottom:6px">
        <span class="chip">Session <b>${fmt(p.receivedKwh, 2)} / 3 kWh</b></span>
        <span class="chip">Charge <b>${p.soc ? Math.round(p.soc) : 0}% / 80%</b></span>
      </div>
      <button class="btn small danger" data-unplug="${p.id}">End session</button>
    </div>` : "";
  return `
    <div class="port-card" data-pid="${p.id}">
      <div class="p-head">
        <div class="p-name">Port ${p.id} ${p.vehicle && p.vehicle.prio ? '<span class="p-flag">PRIORITY ×2</span>' : ""}</div>
        <span class="state-chip ${stCls}">${stTxt}</span>
      </div>
      <div class="p-sub">${info}</div>
      <div class="p-nums">
        <span>Wants <b>${fmt(p.demand, 2)}</b> kW</span>
        <span>Set <b>${fmt(p.setpoint, 2)}</b> kW</span>
        <span>Now <b>${fmt(p.measured, 2)}</b> kW</span>
        ${p.state !== "off" ? `<span>Batt <b>${p.soc ? Math.round(p.soc) : 0}%</b></span>` : ""}
      </div>
      ${p.state !== "off" ? `<div class="progress" style="margin-top:9px"><i style="width:${p.soc || 0}%; background:${p.state === "fault" ? "var(--red)" : "var(--green)"}"></i></div>` : ""}
      ${detail}
    </div>`;
}

/* -------- ENERGY -------- */
function viewEnergy(v) {
  const todayKwh = station.ports.reduce((s, p) => s + p.deliveredKwhDay, 0);
  const lastD = station.days.slice(-7);
  const perPortRows = station.ports.filter((p) => p.deliveredKwhDay > 0)
    .map((p) => ({ label: `Port ${p.id}`, value: p.deliveredKwhDay }));
  const backupToday = station.history.filter((x) => x.day === station.day).reduce((s, x) => s + Math.max(0, x.backup), 0) / 60;
  v.innerHTML = `
    <div class="grid4">
      <div class="stat green"><div class="s-label">Today sold</div><div class="s-val" style="font-size:17px">${fmt(todayKwh)}<span class="s-unit">kWh</span></div></div>
      <div class="stat amber"><div class="s-label">Revenue today</div><div class="s-val" style="font-size:17px">${money(todayKwh * station.revenuePrice)}</div></div>
      <div class="stat sky"><div class="s-label">Backup used</div><div class="s-val" style="font-size:17px">${fmt(backupToday, 2)}<span class="s-unit">kWh</span></div></div>
      <div class="stat purple"><div class="s-label">Grid cost</div><div class="s-val" style="font-size:17px">${money(backupToday * 8)}</div></div>
    </div>
    <div class="card"><h2>Full sim-day power</h2><div id="chart-full"></div>
      <div class="legend"><span><i style="background:var(--green)"></i>Solar</span><span><i style="background:var(--sky)"></i>Load</span><span><i style="background:var(--red)"></i>Backup</span></div></div>
    <div class="card"><h2>Battery level</h2><div id="chart-soc"></div></div>
    <div class="card"><h2>Energy per port today</h2><div id="chart-ports"></div></div>
    <div class="card"><h2>Last days</h2><div id="chart-daily"></div>
      <table class="tbl" style="margin-top:10px">
        <tr><th>Day</th><th class="num">kWh sold</th><th class="num">Backup kWh</th><th class="num">Peak kW</th><th class="num">Revenue</th></tr>
        ${lastD.map((d) => `<tr><td>${d.day}</td><td class="num">${fmt(d.sold)}</td><td class="num">${fmt(d.backup)}</td><td class="num">${fmt(d.peak)}</td><td class="num">${money(d.revenue)}</td></tr>`).join("")}
      </table></div>
    <div class="card"><h2>Your assumptions</h2>
      <div class="field" style="max-width:200px"><label>Charging price, ₹ per kWh</label>
        <input id="e-price" type="number" min="1" step="0.5" value="${station.revenuePrice}" /></div>
      <div class="hint" style="margin-top:6px">Ministry of Power ceilings: ₹3/kWh in solar hours, ₹4 otherwise, where states apply them. Backup power is bought at grid rate (~₹8) so days that lean on backup earn less.</div>
    </div>`;
  const cc = getComputedStyle(document.documentElement);
  const col = (n, f) => cc.getPropertyValue(n).trim() || f;
  const rows = station.history.slice(-720);
  if (rows.length) {
    const mk = (key) => rows.map((r) => ({ x: r.min + (r.day - station.day) * 1440, y: Math.max(0, r[key]) }));
    lineChart($("#chart-full"), [
      { points: mk("solar"), color: col("--green", "#3ddc84"), area: true },
      { points: mk("load"), color: col("--sky", "#55b3ff") },
      { points: mk("backup"), color: col("--red", "#ff6b6b") },
    ], { yMax: CFG.CONVERTER_KW });
    lineChart($("#chart-soc"), [{ points: rows.map((r) => ({ x: r.min, y: r.soc })), color: col("--amber", "#ffc43d"), area: true }], { yMax: 100 });
  }
  barChart($("#chart-ports"), perPortRows.length ? perPortRows : [{ label: "—", value: 0 }], { h: 120 });
  barChart($("#chart-daily"), lastD.map((d) => ({ label: "D" + d.day, value: d.sold, color: col("--green", "#3ddc84") })), { h: 120 });
  const price = $("#e-price");
  price.addEventListener("change", () => {
    station.revenuePrice = Math.max(1, +price.value || 8);
    persistStation(); toast("Price updated"); paint();
  });
}

/* -------- ALERTS -------- */
function viewAlerts(v) {
  if (station.alarms.length) local.set("alertsSeen", station.alarms[0]._id);
  v.innerHTML = `
    <div class="card"><h2>Fault drills</h2>
      <div class="btn-row">
        <button class="btn small amber" id="a-cloud">Cloud front</button>
        <button class="btn small amber" id="a-batt">Battery drains to 24%</button>
        <button class="btn small amber" id="a-thermal">Converter overtemp</button>
      </div>
      <div class="hint" style="margin-top:8px">Each drill creates a field problem; watch the alarm table name it and read the automatic action.</div>
    </div>
    ${station.alarms.map((a) => `
      <div class="alarm ${a.sev === "crit" ? "crit" : a.sev === "warn" ? "warn" : a.sev === "ok" ? "ok" : "info"}">
        <div class="a-time">${a.t}</div>
        <div><div class="a-title">${a.title}</div><div class="a-desc">${a.desc}</div></div>
      </div>`).join("") || '<div class="center-note">No alarms yet.</div>'}`;
  const bind = (id, kind) => { const b = $(id); if (b) b.onclick = () => { station.fault(kind); paint(); }; };
  bind("#a-cloud", "cloud"); bind("#a-batt", "battery"); bind("#a-thermal", "thermal");
}

/* -------- AI -------- */
function viewAI(v) {
  const cfg = getAiConfig();
  v.innerHTML = `
    <div class="ai-status"><span class="dot" style="color:var(--green)"></span>
      <span id="ai-mode">${cfg.model ? `Ollama model ${escapeHtml(cfg.model)} at ${escapeHtml(cfg.baseUrl)}` : "Built-in assistant: answers from live station data. Connect an Ollama model in Settings for free-form questions."}</span>
    </div>
    <div class="chat-wrap">
      <div class="chat-scroll" id="chat-scroll"></div>
      <div class="sugg-row" id="sugg"></div>
      <div class="chat-bar">
        <textarea id="chat-input" rows="1" placeholder="Ask about the station…"></textarea>
        <button class="chat-send" id="chat-send" aria-label="Send"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>
      </div>
    </div>`;
  renderChat();
  const SUGGS = [
    "Why is the backup feed on?",
    "How much will I earn today?",
    "Which ports are charging slowly?",
    "Is the battery healthy?",
    "How do I cut driver waiting time?",
    "Explain today's alarms",
  ];
  const srow = $("#sugg");
  srow.innerHTML = SUGGS.map((s) => `<span class="sugg">${s}</span>`).join("");
  srow.querySelectorAll(".sugg").forEach((s) => { s.onclick = () => sendChat(s.textContent); });

  const input = $("#chat-input");
  const send = $("#chat-send");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(96, input.scrollHeight) + "px"; });
  send.onclick = () => sendChat();
}

function renderChat(streamingText) {
  const sc = $("#chat-scroll");
  if (!sc) return;
  const keepBottom = sc.scrollTop + sc.clientHeight > sc.scrollHeight - 80;
  let html = "";
  for (const m of chatState) {
    html += `<div class="msg ${m.role === "user" ? "user" : "bot"}">${escapeHtml(m.content)}</div>`;
  }
  if (aiBusy) html += `<div class="msg bot" id="live-msg">${streamingText ? escapeHtml(streamingText) : '<span class="typing"><i></i><i></i><i></i></span>'}</div>`;
  sc.innerHTML = html;
  if (!chatState.length && !aiBusy) {
    sc.innerHTML += `<div class="center-note">Your assistant knows your station's live data.<br>Ask a question or tap a suggestion. Nothing leaves this device unless you connect your own Ollama server.</div>`;
  }
  if (keepBottom || aiBusy) sc.scrollTop = sc.scrollHeight;
}
function escapeHtml(s) { return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

async function sendChat(preset) {
  const input = $("#chat-input");
  const q = (preset || input.value || "").trim();
  if (!q || aiBusy) return;
  chatState.push({ role: "user", content: q });
  if (!preset) { input.value = ""; input.style.height = "auto"; }
  local.set("chat", chatState.slice(-40));
  aiBusy = true;
  renderChat("");
  const cfg = await autoDetect();          // picks up an Ollama server on this device if one is running
  let answer = "";
  if (cfg.model) {
    const messages = [
      { role: "system", content: buildSystemPrompt(station, local.get("profile", {}).name) },
      ...chatState.slice(-12),
    ];
    chatAbort = new AbortController();
    try {
      await chat(cfg, messages, (piece, full) => {
        answer = full;
        const el = $("#live-msg");
        if (el) { el.textContent = full; const sc = $("#chat-scroll"); sc.scrollTop = sc.scrollHeight; }
      }, chatAbort.signal);
    } catch (err) {
      // Ollama is configured but not answering: do not leave the owner without an answer.
      answer = err.name === "AbortError" ? "Stopped." : builtinAnswer(station, q) + "\n\n(The Ollama server at " + cfg.baseUrl + " did not answer, so this came from the built-in assistant. Check it under Settings.)";
    }
  } else {
    await new Promise((r) => setTimeout(r, 350));
    answer = builtinAnswer(station, q);
  }
  chatState.push({ role: "assistant", content: answer || "(empty answer)" });
  aiBusy = false;
  local.set("chat", chatState.slice(-40));
  renderChat();
  const mode = $("#ai-mode");
  if (mode && cfg.model) mode.textContent = "Ollama model " + cfg.model + " at " + cfg.baseUrl;
}

/* -------- SETTINGS -------- */
function viewSettings(v) {
  const profile = local.get("profile", {});
  const cfg = getAiConfig();
  v.innerHTML = `
    <div class="card"><h2>Station</h2>
      <div class="field"><label>Station name</label><input id="s-name" value="${escapeHtml(profile.name || "")}" maxlength="40" /></div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn small" id="s-save">Save name</button>
        <button class="btn small" id="s-pin">Change PIN</button>
      </div>
    </div>
    <div class="card"><h2>⏱Station clock (demo)</h2>
      <div class="set-row"><div><div class="sr-label">Simulation speed</div><div class="sr-sub">${station.speed} sim-minutes per real second</div></div>
        <div class="seg" id="seg-speed">
          ${[1, 10, 60, 300].map((s) => `<button data-s="${s}" class="${station.speed === s ? "active" : ""}">${s}×</button>`).join("")}
        </div></div>
      <div class="set-row"><div><div class="sr-label">Pause the controller</div><div class="sr-sub">Freeze sharing while you look around</div></div>
        <button class="btn small ${station.paused ? "" : "green"}" id="s-pause">${station.paused ? "Resume" : "Pause"}</button></div>
      <div class="set-row"><div><div class="sr-label">Reset station data</div><div class="sr-sub">Back to day 1, keeps your PIN and AI settings</div></div>
        <button class="btn small danger" id="s-reset">Reset</button></div>
    </div>
    <div class="card"><h2>AI assistant (Ollama)</h2>
      <div class="field"><label>Ollama server address</label>
        <input id="s-ai-url" value="${escapeHtml(cfg.baseUrl)}" placeholder="http://localhost:11434" /></div>
      <div class="field" style="margin-top:8px"><label>API style</label>
        <div class="seg" id="seg-mode">
          <button data-m="ollama" class="${cfg.mode === "ollama" ? "active" : ""}">Ollama /api</button>
          <button data-m="openai" class="${cfg.mode === "openai" ? "active" : ""}">OpenAI /v1</button>
        </div></div>
      <div class="field" style="margin-top:8px"><label>Model</label>
        <select id="s-ai-model"><option value="">${cfg.model || "— pick a model —"}</option></select></div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn small primary" id="s-ai-test">Test connection & load models</button>
        <button class="btn small" id="s-ai-clear">Clear chat history</button>
      </div>
      <div class="hint" style="margin-top:10px">
        The assistant already answers the common questions from live data. A hosted web page cannot contain an Ollama model: the model runs on your own PC or phone, and this app talks to it.<br><b>How to connect your own Ollama:</b><br>
        1. Install Ollama and pull a small model:<br><code>ollama pull llama3.2:1b</code><br>
        2. Let this app talk to it — set the variable and start Ollama:<br>
        <code>OLLAMA_ORIGINS=* ollama serve</code><br>
        3. Phone option: install <b>Termux</b>, install Ollama inside it, pull a 1B model, then use <code>http://PHONE-IP:11434</code> above (same Wi-Fi).<br>
        4. Desktop option: run Ollama on your PC and use its IP.<br>
        5. Cloud option: use any OpenAI-compatible URL (mode "OpenAI /v1").<br>
        <b>Note:</b> from a https page, phone/PC LAN addresses (http://192.168…) can be blocked by the browser. <a href="#" id="s-copy">Copy this app as local HTML</a> or run Ollama on the phone itself (localhost works even from https in Chrome).
      </div>
    </div>
    <div class="card"><h2>Data</h2>
      <div class="btn-row">
        <button class="btn small" id="s-export">Export data JSON</button>
        <button class="btn small danger" id="s-factory">Factory reset (all)</button>
      </div>
      <div class="hint" style="margin-top:8px">Export saves days, alarms and settings as a file. <b>Device bridge:</b> when your ESP32 controller publishes telemetry, point this app at its HTTP JSON feed (coming from the same MQTT payload format) — the app accepts the same fields it simulates.</div>
    </div>
    <div class="center-note">Silent Assassins · PWA · installable on Android & iPhone<br>v1.1</div>`;

  $("#s-save").onclick = () => {
    const p = local.get("profile", {});
    p.name = $("#s-name").value.trim() || p.name;
    local.set("profile", p); toast("Saved");
  };
  $("#s-pin").onclick = () => {
    const np = prompt("New 4-6 digit PIN:");
    if (np && /^\d{4,6}$/.test(np)) {
      const p = local.get("profile", {});
      p.pinHash = hashPin(np); local.set("profile", p); toast("PIN changed");
    } else if (np !== null) toast("PIN must be 4-6 digits");
  };
  $("#seg-speed").querySelectorAll("button").forEach((b) => {
    b.onclick = () => { station.speed = +b.dataset.s; persistStation(); paint(); };
  });
  $("#s-pause").onclick = () => { station.paused = !station.paused; persistStation(); paint(); };
  $("#s-reset").onclick = () => {
    if (confirm("Reset station to day 1?")) {
      local.del("station"); station = new Station(); persistStation(); toast("Station reset"); go("home");
    }
  };
  $("#seg-mode").querySelectorAll("button").forEach((b) => {
    b.onclick = () => { setAiConfig({ ...cfg, mode: b.dataset.m }); viewSettings(v); };
  });
  const sel = $("#s-ai-model");
  if (cfg.model) sel.insertAdjacentHTML("beforeend", `<option selected>${escapeHtml(cfg.model)}</option>`);
  $("#s-ai-test").onclick = async () => {
    const newCfg = { ...getAiConfig(), baseUrl: $("#s-ai-url").value.trim() || DEFAULT_AI.baseUrl };
    setAiConfig(newCfg);
    const btn = $("#s-ai-test"); btn.textContent = "Testing…"; btn.disabled = true;
    const r = await testConnection(newCfg);
    btn.disabled = false; btn.textContent = "Test connection & load models";
    if (r.ok) {
      sel.innerHTML = '<option value="">— pick a model —</option>' + (r.models || []).map((m) => `<option ${m === newCfg.model ? "selected" : ""}>${escapeHtml(m)}</option>`).join("");
      toast(r.note || "Ollama connected");
    } else {
      toast("Not connected: " + r.error + ". See the steps below.");
    }
  };
  sel.onchange = () => { if (sel.value) { setAiConfig({ ...getAiConfig(), model: sel.value }); toast("Model: " + sel.value); } };
  $("#s-ai-clear").onclick = () => { chatState = []; local.set("chat", []); toast("Chat cleared"); go("ai"); };
  $("#s-export").onclick = () => {
    const blob = new Blob([JSON.stringify({ profile: { name: profile.name }, station: local.get("station", {}), exported: new Date().toISOString() }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "silent-solar-data.json"; a.click();
  };
  $("#s-factory").onclick = () => {
    if (confirm("Erase everything including PIN, AI settings and data?")) { local.clearAll(); location.reload(); }
  };
  $("#s-copy").onclick = (e) => {
    e.preventDefault();
    fetch("./").then((r) => r.text()).catch(() => document.documentElement.outerHTML).then(() => toast("Files are served as plain HTML — save the page from your browser menu: ⋮ → Download"));
  };
}

/* ------------------------------------------------ install banner */
function showInstallBanner() {
  if (local.get("ibDismissed", false) || document.querySelector(".install-banner")) return;
  const b = document.createElement("div");
  b.className = "install-banner";
  b.innerHTML = `
    <div style="font-size:26px"></div>
    <div class="ib-text"><b>Install like an app</b>Add "Silent Assassins" to your home screen — full screen, works offline.</div>
    <button class="btn small primary" id="ib-go">Install</button>
    <button class="icon-btn" id="ib-x" style="width:30px;height:30px" aria-label="Dismiss">×</button>`;
  document.body.appendChild(b);
  $("#ib-go").onclick = async () => {
    if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt = null; }
    else toast("Open browser menu → Add to Home screen");
    b.remove();
  };
  $("#ib-x").onclick = () => { local.set("ibDismissed", true); b.remove(); };
}

/* offline persistence on exit */
window.addEventListener("pagehide", persistStation);
window.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") persistStation(); });

/* register service worker */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
