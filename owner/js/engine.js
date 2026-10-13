/* ============================================================
   Silent Assassins owner app — station control engine
   A faithful simulation of the Silent Assassins controller so the
   owner app works before (and alongside) real hardware link-up.
   Same numbers as the landing model: 10 kWp PV, 20 kWh battery,
   10 kW converter, 3 kW backup feed, 10 ports, 1.5 kW port cap.
   ============================================================ */

export const CFG = {
  PV_KW: 10,
  BATT_KWH: 20,
  CONVERTER_KW: 10,
  BACKUP_KW: 3,
  PORT_CAP_KW: 1.5,
  PORTS: 10,
  RESERVE_PCT: 20,      // battery reserve floor
  BACKUP_ON_PCT: 30,    // engage backup at/below this
  BACKUP_OFF_PCT: 45,   // release backup at/above this
  SESSION_KWH: 3,       // per-session energy cap while others wait
  SESSION_PCT: 80,      // per-session charge target
  RAMP_KWPM: 0.5,       // raise speed, kW per minute
  THERMAL_C: 70,        // thermal derating threshold
};

const VEHICLES = [
  { type: "E-rickshaw", demand: [0.9, 1.4], min: 0.5, kwh: [4, 7], weight: 1 },
  { type: "E-rickshaw (ambulance)", demand: [0.9, 1.4], min: 0.6, kwh: [4, 7], weight: 2, prio: true },
  { type: "E-scooter", demand: [0.5, 0.9], min: 0.3, kwh: [2, 3.5], weight: 1, flag: "scooter" },
  { type: "E-cycle", demand: [0.2, 0.35], min: 0.15, kwh: [0.6, 1.2], weight: 1, flag: "cycle" },
  { type: "Phone locker", demand: 0.12, min: 0.12, kwh: [0.3, 0.6], weight: 1, flag: "locker" },
];

/* Weighted max-min fairness with guaranteed minimums, identical to the firmware rule:
   setpoint[i] = clamp(k * weight[i], min[i], demand[i]) with sum == budget. */
export function allocate(ports, budget) {
  const active = ports.filter((p) => p.state !== "off" && p.demand > 0);
  const totalDem = active.reduce((s, p) => s + p.demand, 0);
  if (active.length === 0) return;
  if (totalDem <= budget) {
    for (const p of active) p.setpoint = p.demand;
    return;
  }
  // total of minimums must fit; if not, least-charged order gets priority every 10 min
  let sumMin = active.reduce((s, p) => s + p.min, 0);
  if (sumMin > budget) {
    const order = [...active].sort((a, b) => a.receivedKwh - b.receivedKwh);
    let left = budget;
    for (const p of order) {
      const give = Math.min(p.min, Math.max(0, left));
      p.setpoint = give;
      left -= give;
    }
    return;
  }
  // bisection on level k
  let lo = 0, hi = 20;
  for (let i = 0; i < 40; i++) {
    const k = (lo + hi) / 2;
    const sum = active.reduce((s, p) => s + Math.min(Math.max(k * p.weight, p.min), p.demand), 0);
    if (sum > budget) hi = k; else lo = k;
  }
  const k = (lo + hi) / 2;
  for (const p of active) p.setpoint = Math.min(Math.max(k * p.weight, p.min), p.demand);
}

function rnd(a, b) { return a + Math.random() * (b - a); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

/* PV curve: bell from 6:00 to 18:30 peaking ~12:30, scaled by cloud factor. */
export function pvPotential(hourFloat, cloud) {
  const t = hourFloat;
  if (t < 6 || t > 18.5) return 0;
  const x = (t - 6) / 12.5;              // 0..1 across the solar day
  const bell = Math.sin(Math.PI * x) ** 1.3;
  return CFG.PV_KW * bell * (1 - 0.95 * cloud);
}

export class Station {
  constructor() {
    this.ports = Array.from({ length: CFG.PORTS }, (_, i) => this.newPort(i));
    this.socPct = 62;
    this.backupOn = false;
    this.tempC = 34;
    this.minOfDay = 8 * 60 + 30;   // sim clock
    this.day = 1;
    this.speed = 60;               // sim minutes per real second
    this.history = [];             // 1 sample per sim minute, trimmed
    this.days = [];                // daily aggregates
    this.alarms = [];              // newest first
    this.revenuePrice = 8;         // ₹ / kWh (editable in Settings)
    this.paused = false;
    this._serial = 0;
    this._turnTimer = 0;
    this.log("ok", "Controller online", "Power budget active. Sharing setpoints applied.");
  }

  newPort(i) {
    return { id: i + 1, state: "off", vehicle: null, demand: 0, min: 0, weight: 1,
             setpoint: 0, measured: 0, soc: 0, receivedKwh: 0, deliveredKwhDay: 0, relay: "closed" };
  }

  hourFloat() { return this.minOfDay / 60; }
  get solarKw() { return this.history.length ? this.history[this.history.length - 1].solar : 0; }

  /* ---------------- arrivals / departures ---------------- */
  maybeArrive() {
    const h = this.hourFloat();
    // arrival rate: busy morning and evening, quiet midday for locker-less demand
    const rate = (h >= 6.5 && h <= 10.5) ? 0.10 : (h >= 15.5 && h <= 20.5) ? 0.13 : (h > 21) ? 0.03 : 0.05;
    if (this.freePort() && Math.random() < rate) this.plugIn(false);
  }
  freePort() { return this.ports.find((p) => p.state === "off"); }
  plugIn(priority) {
    const port = this.freePort();
    if (!port) return null;
    let v;
    if (priority) v = VEHICLES[Math.random() < 0.6 ? 1 : 0];
    else v = VEHICLES[Math.floor(Math.random() * VEHICLES.length)];
    port.state = "wait";
    port.vehicle = { type: v.type, prio: !!v.prio, targetPct: CFG.SESSION_PCT };
    port.demand = v.demand ? rnd(v.demand[0], v.demand[1]) : v.demand;
    port.min = v.min;
    port.weight = v.weight;
    port.soc = rnd(5, 45);
    port.receivedKwh = 0;
    port._kwhNeed = rnd(v.kwh[0], v.kwh[1]);
    return port;
  }
  unplug(portId) {
    const p = this.ports.find((x) => x.id === portId || x === portId);
    if (!p || p.state === "off") return;
    this.log("info", `${p.vehicle ? p.vehicle.type : "Vehicle"} left port ${p.id}`,
      `Delivered ${p.deliveredKwhDay.toFixed(2)} kWh today.`);
    p.state = "off"; p.vehicle = null; p.demand = 0; p.setpoint = 0; p.receivedKwh = 0; p.soc = 0;
  }
  addWaiting(priority) {
    const p = this.plugIn(priority);
    if (p) {
      this.log("info", `${p.vehicle.type} plugged into port ${p.id}`,
        priority ? "Priority user: weight doubled in fair share." : "Vehicle requests " + p.demand.toFixed(2) + " kW.");
    } else {
      this.log("warn", "Queue full", "Every port has a vehicle. New arrival waits in the lane.");
    }
    return p;
  }

  /* ---------------- faults ---------------- */
  fault(kind, portId) {
    if (kind === "overdraw") {
      const p = this.ports.find((x) => x.id === portId);
      if (p && p.state !== "off") {
        p.relay = "open"; p.state = "fault"; p.measured = 0;
        this.log("crit", `Relay opened on port ${p.id}`, "Port drew over 120% of its setpoint. Fault isolated; other ports unaffected.");
      }
    } else if (kind === "thermal") {
      this.tempC += 22;
    } else if (kind === "cloud") {
      this._cloudSpike = 0.9;
    } else if (kind === "battery") {
      this.socPct = Math.min(this.socPct, 24);
    }
  }

  log(sev, title, desc) {
    this.alarms.unshift({ sev, title, desc, t: this.stamp(), day: this.day, min: this.minOfDay, _id: ++this._serial });
    if (this.alarms.length > 120) this.alarms.pop();
  }
  stamp() {
    const h = Math.floor(this.hourFloat()), m = Math.floor(this.minOfDay % 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  /* ---------------- one control tick, called once per SIM MINUTE ---------------- */
  tick(minutes = 1) {
    for (let m = 0; m < minutes; m++) {
      this.stepMinute();
    }
  }
  stepMinute() {
    const h = this.hourFloat();

    // cloud: random weather moves slowly; spikes decay
    this._cloud = clamp((this._cloud ?? this._baseCloud ?? 0.15) , 0, 1);
    if (this._cloudSpike) { this._cloud = clamp(this._cloud + this._cloudSpike, 0, 1); this._cloudSpike = 0; }
    this._cloud += rnd(-0.02, 0.02) + (this._baseCloudDrift ?? 0);
    this._cloud = clamp(this._cloud, 0, 0.95);

    const pv = pvPotential(h, this._cloud);
    this.tempC += (pv > 0 ? 0.05 : -0.08) + rnd(-0.3, 0.3);
    this.tempC = clamp(this.tempC, 18, 85);

    // arrivals
    this.maybeArrive();

    // thermal derating: above 70 °C the converter budget falls linearly to 60 %
    let derate = 1;
    if (this.tempC > CFG.THERMAL_C) derate = clamp(1 - (this.tempC - CFG.THERMAL_C) / 50, 0.6, 1);

    // battery allowance and backup feed
    const battAvailKw = Math.max(0, (this.socPct - CFG.RESERVE_PCT) / 100 * CFG.BATT_KWH * 1.5); // ≤1.5C discharge
    if (!this.backupOn && this.socPct <= CFG.BACKUP_ON_PCT) {
      this.backupOn = true;
      this.log("warn", "Backup feed engaged", `Battery at ${this.socPct.toFixed(0)}%. 3 kW grid feed added to the budget; it never charges the battery.`);
    } else if (this.backupOn && this.socPct >= CFG.BACKUP_OFF_PCT) {
      this.backupOn = false;
      this.log("ok", "Backup feed released", `Battery recovered to ${this.socPct.toFixed(0)}%. Back on sun + battery alone.`);
    }
    if (this.socPct <= CFG.RESERVE_PCT + 1 && battAvailKw < 0.05) {
      this.log("crit", "Battery reserve floor", "Only solar and the backup feed can supply ports now. Battery protected at 20 %.");
    }

    let budget = Math.min(CFG.CONVERTER_KW, pv + battAvailKw + (this.backupOn ? CFG.BACKUP_KW : 0)) * derate;

    // active ports: charging or waiting; session limits
    for (const p of this.ports) {
      if (p.state === "fault") continue;
      if (p.state === "off") { p.setpoint = 0; p.measured = 0; continue; }
      const neededKw = Math.max(0, (CFG.SESSION_PCT - p.soc) / 100 * p._kwhNeed * 1.2);
      p.demand = Math.min(Math.max(p.demand, p.min), CFG.PORT_CAP_KW, Math.max(neededKw, p.min));
      if (p.receivedKwh >= CFG.SESSION_KWH && p.soc < CFG.SESSION_PCT) {
        p.demand = Math.min(p.demand, p.min);
      }
    }
    allocate(this.ports, budget);

    // apply power; cuts immediate, raises ramped at 0.5 kW per minute
    let load = 0, offeredToBatt = pv;
    for (const p of this.ports) {
      if (p.state === "off" || p.state === "fault") { p.measured = 0; continue; }
      const prev = p.measured || 0;
      const target = p.setpoint;
      p.measured = target <= prev ? target : Math.min(target, prev + CFG.RAMP_KWPM);
      if (p.relay === "open") { p.measured = 0; p.setpoint = 0; continue; }
      const dm = p.measured;
      load += dm;
      offeredToBatt -= dm;
      const kWh = dm / 60;
      p.receivedKwh += kWh;
      p.soc = clamp(p.soc + (kWh / Math.max(p._kwhNeed, 0.1)) * CFG.SESSION_PCT, 0, 100);
      p.deliveredKwhDay += kWh;
      p.state = p.soc >= CFG.SESSION_PCT ? "full" : "charge";
    }

    // battery: leftover PV charges it, up to charge C-rate; otherwise battery discharges for the load
    const battRoomKw = Math.max(0, (100 - this.socPct) / 100 * CFG.BATT_KWH * 0.5);
    const toBatt = clamp(offeredToBatt, 0, battRoomKw);
    const fromBattForLoad = Math.max(0, load - pv);
    const battKw = toBatt / 60 - fromBattForLoad / 60; // ± kWh this minute
    this.socPct = clamp(this.socPct + (battKw / CFG.BATT_KWH) * 100, 0, 100);
    load = Math.min(load, pv + battAvailKw + (this.backupOn ? CFG.BACKUP_KW : 0));

    // departures: full or session done
    for (const p of this.ports) {
      if ((p.state === "full" || p.measured === 0) && p.state !== "off") {
        if ((p.soc >= CFG.SESSION_PCT && Math.random() < 0.06) || (p.state === "fault" && Math.random() < 0.02)) this.unplug(p);
      }
    }

    // history + day rollover
    const solarNet = pv;
    this.history.push({ t: this.stamp(), min: this.minOfDay, day: this.day, solar: +solarNet.toFixed(2), load: +load.toFixed(2),
      backup: this.backupOn ? +(load - Math.max(0, pv + (this.socPct > CFG.RESERVE_PCT ? load - pv : 0))).toFixed(2) : 0,
      budget: +budget.toFixed(2), soc: +this.socPct.toFixed(1), temp: +this.tempC.toFixed(0), cloud: +this._cloud.toFixed(2) });
    if (this.history.length > 4320) this.history.splice(0, this.history.length - 4320); // ~3 days at 1-min

    this.minOfDay++;
    if (this.minOfDay >= 1440) {
      this.rollDay();
    }
  }

  rollDay() {
    const sold = this.ports.reduce((s, p) => s + p.deliveredKwhDay, 0);
    const backupKwh = this.history.filter((x) => x.day === this.day && x.backup > 0.01)
      .reduce((s, x) => s + x.backup / 60, 0);
    this.days.push({ day: this.day, sold: +sold.toFixed(1), backup: +backupKwh.toFixed(1),
      peak: Math.max(...this.history.filter((x) => x.day === this.day).map((x) => x.load), 0),
      revenue: +(sold * this.revenuePrice).toFixed(0) });
    for (const p of this.ports) p.deliveredKwhDay = 0;
    // carry over: keep a few vehicles from evening running late? simply clear most
    for (const p of this.ports) { if (p.state !== "off" && Math.random() < 0.85) this.unplug(p); }
    this.day++;
    this.minOfDay = 0;
    this.log("info", `Day ${this.day - 1} closed`, `Sold ${sold.toFixed(1)} kWh (₹${(sold * this.revenuePrice).toFixed(0)}). New day started.`);
  }

  /* serialized snapshot for the AI assistant */
  snapshot() {
    const h = this.history[this.history.length - 1];
    const active = this.ports.filter((p) => p.state !== "off");
    const waiting = active.filter((p) => p.state === "wait").length;
    const charging = active.filter((p) => p.state === "charge" || p.state === "full").length;
    const today = this.ports.reduce((s, p) => s + p.deliveredKwhDay, 0);
    return {
      time: this.stamp() + ", day " + this.day,
      solarKw: +(pvPotential(this.hourFloat(), this._cloud ?? 0.2)).toFixed(2),
      loadKw: h ? h.load : 0,
      budgetKw: h ? h.budget : 0,
      batteryPct: +this.socPct.toFixed(0),
      backupOn: this.backupOn,
      converterTempC: Math.round(this.tempC),
      cloud: +((this._cloud ?? 0.2) * 100).toFixed(0) + "%",
      portsPlugged: active.length,
      charging, waiting,
      energyTodayKwh: +today.toFixed(1),
      estRevenueToday: Math.round(today * this.revenuePrice),
      pricePerKwh: this.revenuePrice,
      recentAlarms: this.alarms.slice(0, 6).map((a) => `${a.sev.toUpperCase()} ${a.t} ${a.title}`),
      portLines: this.ports.map((p) => `#p${p.id} ${p.state} ${p.vehicle ? p.vehicle.type : ""} want ${p.demand.toFixed(2)}kW set ${p.setpoint.toFixed(2)}kW ${p.soc ? p.soc.toFixed(0) + "%" : ""}`).join("\n"),
    };
  }

  waitingEstimate(port) {
    const owed = this.ports.filter((p) => p !== port && p.state !== "off")
      .reduce((s, p) => s + Math.max(0, p._kwhNeed * CFG.SESSION_PCT / 100 - p.receivedKwh), 0);
    const supply = Math.max(0.5, this.history[this.history.length - 1]?.budget ?? 5);
    return owed / supply * 60; // minutes
  }
}
