/* ============================================================
   AI assistant client — talks to Ollama.
   Default endpoint http://localhost:11434 (Ollama on the owner's
   phone via Termux, or on the office PC / Raspberry Pi). Also
   supports an OpenAI-compatible endpoint (e.g. Ollama Cloud,
   LM Studio) via /v1/chat/completions.
   ============================================================ */
import { local } from "./store.js";

export const DEFAULT_AI = { baseUrl: "http://localhost:11434", model: "", mode: "ollama" };

export function getAiConfig() { return local.get("ai", DEFAULT_AI); }
export function setAiConfig(cfg) { local.set("ai", { ...DEFAULT_AI, ...cfg }); }

function normBase(url) {
  if (!url) return "";
  let u = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(u)) u = "http://" + u;
  return u;
}

/** Discover local models via Ollama /api/tags. Returns [names]. */
export async function listModels(baseUrl) {
  const base = normBase(baseUrl);
  const res = await fetch(`${base}/api/tags`, { method: "GET" });
  if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
  const data = await res.json();
  return (data.models || []).map((m) => m.name);
}

export async function testConnection(cfg) {
  try {
    const models = await listModels(cfg.baseUrl);
    if (!models.length) return { ok: true, note: "Ollama is reachable but no models are pulled yet. Run: ollama pull llama3.2:1b" };
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Build the system prompt with the live station snapshot so answers use real data. */
export function buildSystemPrompt(st, stationName) {
  if (!st) return "You are the helpful assistant of a solar EV charging station owner app.";
  const s = st.snapshot();
  return `You are the built-in AI assistant of "${stationName || "my solar charging station"}", the mobile owner app of the Silent Assassins power-sharing controller.

You ARE an assistant inside the controller ecosystem. You speak with the station's data in hand. Answer briefly (2-6 sentences), practical, plain language. Use ₹ for money. The owner may be on a slow connection; be concise.

Current station snapshot (JSON):
${JSON.stringify(s, null, 1)}

Port detail:
${s.portLines}

Facts about the Silent Assassins controller you can rely on:
- Budget = min(converter 10 kW, solar + battery allowance above 20% reserve + 3 kW backup).
- Sharing: weighted max-min fairness, guaranteed minimums; priority users count double; cuts are instant, raises ramp at 0.5 kW/min.
- Backup feed engages at battery <= 30%, releases at 45%; it never charges the battery.
- Each session is capped at 3 kWh or 80% charge while others wait; ports capped at 1.5 kW.
- Backup kWh sold is bought from the grid, so it costs the owner (grid price vs charging price).

Answer the owner's question using the snapshot numbers when relevant. If data is unavailable, say so honestly.`;
}

/** Stream a chat answer. onChunk(text) is called repeatedly; resolves with full text. */
export async function chat(cfg, messages, onChunk, signal) {
  const base = normBase(cfg.baseUrl);
  const useOpenAI = cfg.mode === "openai";
  const url = useOpenAI ? `${base}/v1/chat/completions` : `${base}/api/chat`;
  const body = useOpenAI
    ? { model: cfg.model, messages, stream: true }
    : { model: cfg.model, messages, stream: true };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${text ? " — " + text.slice(0, 200) : ""}`);
  }
  if (!res.body) throw new Error("Streaming not supported by this endpoint");

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        // Ollama NDJSON: {message:{content}} / final {done:true}; OpenAI SSE-ish: {choices:[{delta}]}
        let piece = "";
        if (j.message && j.message.content) piece = j.message.content;
        else if (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) piece = j.choices[0].delta.content;
        if (piece) { full += piece; onChunk(piece, full); }
      } catch { /* not JSON (maybe SSE "data: ...") */ }
    }
  }
  return full;
}

/** Look for an Ollama server without making the owner open Settings: if one answers and no model
    is chosen yet, take the first model it has. Gives up after 1.5 s so the chat never hangs. */
export async function autoDetect() {
  const cfg = getAiConfig();
  if (cfg.model) return cfg;
  try {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 1500);
    const res = await fetch(`${normBase(cfg.baseUrl)}/api/tags`, { signal: ctl.signal });
    clearTimeout(t);
    const models = ((await res.json()).models || []).map((m) => m.name);
    if (models.length) { const next = { ...cfg, model: models[0] }; setAiConfig(next); return next; }
  } catch { /* no server on this device: the built-in assistant answers instead */ }
  return cfg;
}

/** Built-in assistant: answers the common owner questions straight from the live station data.
    It needs no server, so the Assistant tab works on any phone; an Ollama model, when connected,
    takes over and handles free-form questions. */
export function builtinAnswer(st, question) {
  const s = st.snapshot(), q = (question || "").toLowerCase(), has = (...w) => w.some((x) => q.includes(x));
  const act = st.ports.filter((p) => p.state !== "off");
  const money = (n) => "₹" + Math.round(n).toLocaleString("en-IN");
  if (has("backup", "grid")) {
    return s.backupOn
      ? `The backup feed is ON because the battery is at ${s.batteryPct}%. It engages at 30% or below and adds up to 3 kW to the power budget; it releases once the battery is back to 45%. Every backup unit is bought from the grid, so it lowers today's margin.`
      : `The backup feed is off. The battery is at ${s.batteryPct}%, above the 30% level where backup engages, so the station is running on solar and battery only.`;
  }
  if (has("earn", "revenue", "money", "income", "profit", "₹", "rupee")) {
    return `So far today the station has sold ${s.energyTodayKwh} kWh, which is about ${money(s.estRevenueToday)} at ${money(s.pricePerKwh)} per kWh. Right now ${s.charging} vehicle(s) are charging at a total of ${(+s.loadKw).toFixed(1)} kW. You can change the price under Energy.`;
  }
  if (has("slow", "which port", "ports", "sharing", "share")) {
    const slow = act.filter((p) => p.state === "charge" && p.setpoint < p.demand - 0.05);
    if (!act.length) return "No vehicle is plugged in right now, so every port is free.";
    return slow.length
      ? `${slow.length} port(s) are below what the vehicle asks for because demand is above the ${(+s.budgetKw).toFixed(1)} kW budget: ` + slow.map((p) => `port ${p.id} gets ${p.setpoint.toFixed(2)} of ${p.demand.toFixed(2)} kW`).join("; ") + ". The controller is sharing fairly, and nothing has tripped."
      : `All ${act.length} plugged-in port(s) are getting the power they ask for. The budget is ${(+s.budgetKw).toFixed(1)} kW and the load is ${(+s.loadKw).toFixed(1)} kW.`;
  }
  if (has("battery", "soc", "health", "reserve")) {
    const state = s.batteryPct <= 20 ? "at the 20% reserve floor, so it is not discharging" : s.batteryPct <= 30 ? "low, so its support is being reduced and backup is allowed in" : "in its normal working range";
    return `The battery is at ${s.batteryPct}%, ${state}. The controller never takes it below 20% and starts the backup feed at 30%, which protects cell life. Converter temperature is ${s.converterTempC} °C (derating starts at 70 °C).`;
  }
  if (has("wait", "queue", "waiting", "faster")) {
    return `The estimated wait for the next arrival is about ${Math.round(st.waitingEstimate())} minutes, with ${s.waiting} vehicle(s) waiting and ${s.charging} charging. To cut waiting: keep the fair-use cap on (3 kWh or 80% per session while others wait), steer drivers to solar hours when the budget is highest, and add panels or ports if the queue is long every day.`;
  }
  if (has("alarm", "alert", "fault", "problem", "error", "trip")) {
    return s.recentAlarms.length ? "Most recent events: " + s.recentAlarms.slice(0, 4).join("; ") + ". Open the Alerts tab for the cause and the automatic action taken for each one." : "There are no alarms. The station is running normally.";
  }
  if (has("solar", "sun", "cloud", "panel", "weather")) {
    return `Solar output is ${s.solarKw} kW now with ${s.cloud} cloud cover. The station can pass at most 10 kW through the converter; anything the sun does not cover comes from the battery and, when it is low, the 3 kW backup feed.`;
  }
  if (has("temp", "hot", "heat", "cool")) {
    return `The converter is at ${s.converterTempC} °C. Above 70 °C the controller derates the station limit until it cools down, so charging slows but does not stop.`;
  }
  return `Station at ${s.time}: solar ${s.solarKw} kW, load ${(+s.loadKw).toFixed(1)} kW of a ${(+s.budgetKw).toFixed(1)} kW budget, battery ${s.batteryPct}%, backup ${s.backupOn ? "on" : "off"}, ${s.charging} charging and ${s.waiting} waiting, ${s.energyTodayKwh} kWh sold today (${money(s.estRevenueToday)}). I can answer questions about backup, earnings, slow ports, battery, waiting time, alarms, solar and temperature. Connect an Ollama model in Settings for free-form questions.`;
}
