/* Silent Assassins station model + load-sharing controller. No DOM access: runs in the page and in Node. */
(function (root) {
  'use strict';

  const CFG = {
    pvKwp: 10, pvDerate: 0.82,           // 10 kWp array, wiring/temperature/soiling derate
    battKwh: 20, battMaxC: 6, battMaxD: 6, // 48 V LFP bank, charge / discharge power limits (kW)
    gridKw: 3, gridOn: 30, gridOff: 45,   // backup feed rating (kW); engages at this battery %, releases at this %
    socFloor: 20, socDerate: 30,          // reserve floor and the SoC where discharge derating starts (%)
    eff: 0.95, chgEff: 0.93,              // battery one-way efficiency, port converter efficiency
    busKw: 10, ports: 10, portMax: 1.5,   // DC bus / converter rating, port count, per-port cap (kW)
    rampUp: 0.5,                          // setpoints rise at most this fast (kW per minute); cuts are instant
    fairKwh: 3, fairSoc: 80,              // fair-use cap per session while others wait
    rotateMin: 10,                        // how often the hold order is re-ranked when power is scarce
    carPorts: 2, carMax: 3.3,             // the last two ports are car bays with a higher cap (kW)
    queueMax: 12, arrX: 1.8, tripMin: 5, hotC: 70, noun: 'vehicle'   // arrX scales arrivals to the larger site
  };

  const TYPES = {
    rick:  { code: 'R', name: 'E-rickshaw',   max: 1.2,  min: 0.30, cap: 5.0 },
    scoot: { code: 'S', name: 'E-scooter',    max: 0.9,  min: 0.20, cap: 3.0 },
    cycle: { code: 'C', name: 'E-cycle',      max: 0.3,  min: 0.08, cap: 0.6 },
    phone: { code: 'M', name: 'Phone locker', max: 0.12, min: 0.03, cap: 0.2 },
    // A car only fits a car bay. It arrives for a top-up (topUp % of its battery) and has its own fair-use cap (kWh).
    car:   { code: 'E', name: 'E-car',        max: 3.3,  min: 1.0,  cap: 30, car: true, topUp: 30, fair: 8 }
  };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* The allocation rule (weighted max-min share with a guaranteed minimum).
     items arrive in admission order; each has {demand, min, weight}.
     1. Admit items while their minimums still fit in the budget; the rest are held at 0.
     2. Find the water level k so that sum(clamp(k * weight, min, demand)) equals the budget.
     Small loads get all they ask for, large loads split what is left equally, priority counts double. */
  function shareOut(budget, items) {
    const alloc = items.map(() => 0);
    const adm = [];
    let rem = budget;
    items.forEach((it, i) => {
      if (it.demand <= 0) return;
      const m = Math.min(it.min, it.demand);
      if (m <= rem + 1e-9) { adm.push(i); rem -= m; }
    });
    if (!adm.length) return alloc;
    const floor = i => Math.min(items[i].min, items[i].demand);
    const total = k => adm.reduce((s, i) => s + clamp(k * items[i].weight, floor(i), items[i].demand), 0);
    const wanted = adm.reduce((s, i) => s + items[i].demand, 0);
    if (wanted <= budget + 1e-9) { adm.forEach(i => { alloc[i] = items[i].demand; }); return alloc; }
    let lo = 0, hi = 1;
    while (total(hi) < budget && hi < 1e6) hi *= 2;
    for (let n = 0; n < 40; n++) { const mid = (lo + hi) / 2; if (total(mid) > budget) hi = mid; else lo = mid; }
    adm.forEach(i => { alloc[i] = clamp(lo * items[i].weight, floor(i), items[i].demand); });
    return alloc;
  }

  function arrivalRate(t) {            // vehicles per hour by time of day
    if (t >= 360 && t < 480) return 0.8;
    if (t >= 480 && t < 660) return 1.8;
    if (t >= 660 && t < 960) return 1.0;
    if (t >= 960 && t < 1140) return 1.6;
    if (t >= 1140 && t < 1320) return 0.45;
    return 0.06;
  }
  function pickType(r) { return r < 0.4 ? 0 : r < 0.66 ? 1 : r < 0.78 ? 2 : r < 0.88 ? 3 : 4; }

  class Station {
    constructor(o) {
      o = o || {};
      this.smart = o.smart !== false;
      this.c = Object.assign({}, CFG, o.cfg || {});
      this.T = o.types || TYPES;
      this.keys = Object.keys(this.T);
      this.rand = rng(o.seed || 7);
      this.t = o.startMin == null ? 600 : o.startMin;
      this.day = 0;
      this.auto = !!o.auto;
      this.backup = o.backup !== false; this.gridOn = false;
      this.cloud = 0.1; this.soc = 60; this.temp = 34; this.hot = false;
      this.ports = [];
      for (let i = 0; i < this.c.ports; i++) { const car = i >= this.c.ports - this.c.carPorts; this.ports.push({ id: i + 1, car: car, max: car ? this.c.carMax : this.c.portMax, s: null, fault: null, comms: true, inject: false, set: 0, meas: 0 }); }
      this.queue = [];
      this.faults = { pvString: false, fan: false, bms: false, grid: false };
      this.seq = 0; this.events = [];
      this.tripUntil = -1; this.blocked = false; this.blockedAt = 0;
      this.rankAt = -1e9; this.rankDirty = true;
      this.m = { kwh: 0, pvKwh: 0, curtKwh: 0, served: 0, trips: 0, downMin: 0, waitSum: 0, waitN: 0, waitMax: 0, turned: 0, minSoc: 100, fairSum: 0, fairN: 0, gridKwh: 0 };
      this.now = { pv: 0, exp: 0, budget: 0, busLim: this.c.busKw, battD: 0, load: 0, demand: 0, batt: 0, grid: 0, gridAvail: 0, curt: 0, limiter: 'none', fair: 1, tripped: false, tripLeft: 0 };
    }
    abs() { return this.day * 1440 + this.t; }
    log(kind, msg) { this.events.unshift({ t: this.t, kind: kind, msg: msg }); if (this.events.length > 60) this.events.pop(); }
    // A car needs a car bay. Light vehicles take a light port first, and a car bay only while no car is waiting.
    portFor(u) {
      const free = this.ports.filter(p => !p.s && !p.fault);
      if (this.T[u.type].car) return free.find(p => p.car) || null;
      return free.find(p => !p.car) || (this.queue.some(q => this.T[q.type].car) ? null : free.find(p => p.car)) || null;
    }
    tripped() { return !this.smart && this.abs() < this.tripUntil; }
    canPlug() { return this.smart || (!this.blocked && !this.tripped()); }

    arrive(type, prio, soc) {
      const T = this.T[type];
      const r = this.rand();
      if (this.queue.length >= this.c.queueMax) { this.m.turned++; this.log('leave', T.name + ' turned away: queue is full'); return null; }
      this.seq++;
      const s0 = soc == null ? 15 + r * 35 : soc;
      const u = { token: T.code + '-' + String(this.seq).padStart(2, '0'), type: type, prio: !!prio, soc0: s0, soc: s0, target: T.topUp ? Math.min(90, Math.round(s0 + T.topUp)) : 90, kwh: 0, arrived: this.abs(), demand: 0, rank: 99, state: 'queue', wait: 0 };
      if (u.prio && this.smart) {
        let i = 0; while (i < this.queue.length && this.queue[i].prio) i++;
        this.queue.splice(i, 0, u);
      } else this.queue.push(u);
      this.log('join', u.token + ' (' + T.name + (u.prio ? ', priority' : '') + ') arrived at ' + Math.round(s0) + '% charge');
      this.fillPorts();
      return u;
    }
    fillPorts() {
      if (!this.canPlug()) return;
      for (let i = 0; i < this.queue.length;) {
        const u = this.queue[i], p = this.portFor(u);
        if (!p) { i++; continue; }                 // no suitable port yet: the next in line may still fit
        this.queue.splice(i, 1);
        p.s = u; p.set = 0; u.state = 'full'; u.plugged = this.abs();
        if (u.waited == null) {
          u.waited = u.plugged - u.arrived;
          this.m.waitSum += u.waited; this.m.waitN++; this.m.waitMax = Math.max(this.m.waitMax, u.waited);
        }
        this.rankDirty = true;
        this.log('join', u.token + ' plugged into port ' + p.id);
      }
    }
    release(p, why) {
      const u = p.s; if (!u) return;
      p.s = null; p.set = 0; p.meas = 0; this.rankDirty = true;
      if (why === 'full') { this.m.served++; this.log('done', u.token + ' finished at ' + Math.round(u.soc) + '% and left port ' + p.id); }
      else if (why === 'fair') { this.m.served++; this.log('done', u.token + ' reached the fair-use limit (' + u.kwh.toFixed(1) + ' kWh, ' + Math.round(u.soc) + '%) and freed port ' + p.id); }
      else this.log('leave', u.token + ' unplugged from port ' + p.id);
      this.blocked = false;
      this.fillPorts();
    }
    leave(token) {
      const p = this.ports.find(x => x.s && x.s.token === token);
      if (p) { this.release(p, 'user'); return; }
      const i = this.queue.findIndex(u => u.token === token);
      if (i >= 0) { this.queue.splice(i, 1); this.log('leave', token + ' left the queue'); }
    }
    resetPort(id) {
      const p = this.ports[id - 1];
      p.fault = null; p.inject = false; p.comms = true;
      this.log('ok', 'Port ' + id + ' reset by operator');
      this.fillPorts();
    }
    isolate(p, why) {
      const u = p.s;
      p.fault = why; p.set = 0; p.meas = 0; p.inject = false;
      if (u) { p.s = null; u.state = 'queue'; this.queue.unshift(u); this.rankDirty = true; }
      this.log('alarm', 'Port ' + p.id + ' isolated (overcurrent)' + (u ? '; ' + u.token + ' moved to the front of the queue' : ''));
      this.fillPorts();
    }

    step(dt) {
      const N = this.now, dtH = dt / 60;
      this.t += dt;
      if (this.t >= 1440) { this.t -= 1440; this.day++; }
      const abs = this.abs();

      if (this.auto && dt > 0 && this.rand() < arrivalRate(this.t) * this.c.arrX / 60 * dt) this.arrive(this.keys[pickType(this.rand())], this.rand() < 0.08);

      // Sources and limits
      const x = (this.t - 360) / 720;
      const clear = x > 0 && x < 1 ? Math.pow(Math.sin(Math.PI * x), 1.2) : 0;
      N.exp = this.c.pvKwp * this.c.pvDerate * clear;
      N.pv = N.exp * (1 - 0.75 * this.cloud) * (this.faults.pvString ? 0.5 : 1);
      this.hot = this.temp > this.c.hotC || (this.hot && this.temp > this.c.hotC - 5);
      N.busLim = this.c.busKw * (this.hot && this.smart ? 0.6 : 1);
      const socD = this.faults.bms ? 0 : clamp((this.soc - this.c.socFloor) / (this.c.socDerate - this.c.socFloor), 0, 1);
      N.battD = this.c.battMaxD * socD;
      // Backup feed: comes in when the battery is low or offline, goes out once it has recovered (hysteresis)
      if (this.soc <= this.c.gridOn || this.faults.bms) this.gridOn = true;
      else if (this.soc >= this.c.gridOff) this.gridOn = false;
      N.gridAvail = this.backup && this.gridOn && !this.faults.grid ? this.c.gridKw : 0;
      N.budget = Math.min(N.busLim, N.pv + N.battD + N.gridAvail);

      // What each connected vehicle can accept right now
      this.ports.forEach(p => { if (!p.s) { p.set = 0; p.meas = 0; } });
      const act = this.ports.filter(p => p.s && !p.fault);
      act.forEach(p => {
        const u = p.s, T = this.T[u.type];
        const taper = u.soc < 80 ? 1 : 1 - 0.7 * (u.soc - 80) / 20;
        u.demand = Math.min(p.max, T.max * taper);
        if (!p.comms && this.smart) u.demand = Math.min(u.demand, T.min);   // fail-safe: no feedback, minimum power only
      });
      N.demand = act.reduce((s, p) => s + p.s.demand, 0);
      N.tripped = false; N.tripLeft = 0;

      if (this.smart) {
        act.filter(p => p.inject).forEach(p => this.isolate(p, 'oc'));
        const live = this.ports.filter(p => p.s && !p.fault);
        live.forEach(p => { if (!p.s.demand) { const T = this.T[p.s.type]; p.s.demand = Math.min(p.max, T.max); } });
        N.demand = live.reduce((s, p) => s + p.s.demand, 0);
        if (this.rankDirty || abs - this.rankAt >= this.c.rotateMin) {
          const prog = u => (u.soc - u.soc0) / Math.max(1, u.target - u.soc0);
          live.slice().sort((a, b) => prog(a.s) - prog(b.s)).forEach((p, i) => { p.s.rank = i; });
          this.rankAt = abs; this.rankDirty = false;
        }
        const order = live.slice().sort((a, b) => (b.s.prio - a.s.prio) || (a.s.rank - b.s.rank));
        const alloc = shareOut(N.budget, order.map(p => ({ demand: p.s.demand, min: this.T[p.s.type].min, weight: p.s.prio ? 2 : 1 })));
        order.forEach((p, i) => {
          const u = p.s, tgt = alloc[i];
          p.set = tgt < p.set ? tgt : Math.min(tgt, p.set + this.c.rampUp * dt);
          u.state = tgt <= 0 ? 'hold' : (tgt < u.demand - 0.02 ? 'shared' : 'full');
        });
      } else {
        if (this.blocked && abs - this.blockedAt > 60) { this.blocked = false; this.fillPorts(); }
        if (N.pv + N.battD + N.gridAvail < 0.15 && abs >= this.tripUntil) {   // no sun and battery at reserve: station is simply dark
          act.forEach(p => { p.set = 0; p.s.state = 'hold'; });
        } else if (abs < this.tripUntil) {
          act.forEach(p => { p.set = 0; p.s.state = 'trip'; });
          this.m.downMin += dt; N.tripped = true; N.tripLeft = this.tripUntil - abs;
        } else {
          const load = N.demand;
          const short = act.some(p => p.inject);
          if (act.length && (load > N.busLim + 1e-6 || load - N.pv > N.battD + N.gridAvail + 1e-6 || this.temp > 85 || short)) {
            this.tripUntil = abs + this.c.tripMin; this.m.trips++; this.blocked = true; this.blockedAt = abs;
            N.tripped = true; N.tripLeft = this.c.tripMin;
            const sp = act.find(p => p.inject);
            if (sp) { sp.fault = 'oc'; sp.inject = false; const u = sp.s; sp.s = null; if (u) { u.state = 'queue'; this.queue.unshift(u); } }
            else {
              const last = act.slice().sort((a, b) => b.s.plugged - a.s.plugged)[0];
              const u = last.s; last.s = null; u.state = 'queue'; this.queue.unshift(u);
            }
            this.ports.forEach(p => { p.set = 0; if (p.s) p.s.state = 'trip'; });
            this.log('alarm', 'Overload trip: all ports off for ' + this.c.tripMin + ' min, one ' + this.c.noun + ' sent back to the queue');
          } else act.forEach(p => { p.set = p.s.demand; p.s.state = 'full'; });
        }
      }

      // Energy balance on the DC bus
      let load = this.ports.reduce((s, p) => s + p.set, 0);
      const supply = N.pv + N.battD + N.gridAvail;
      if (load > supply + 1e-6) {                   // guard: never draw more than the sources can give
        const k = supply / load;
        this.ports.forEach(p => { p.set *= k; });
        load = supply;
      }
      N.grid = 0;
      const net = N.pv - load;
      if (net >= 0) {
        const room = dtH > 0 ? (100 - this.soc) / 100 * this.c.battKwh / dtH / this.c.eff : Infinity;
        const ch = this.faults.bms ? 0 : Math.max(0, Math.min(net, this.c.battMaxC, room));
        this.soc += ch * this.c.eff * dtH / this.c.battKwh * 100;
        N.batt = -ch; N.curt = net - ch;
      } else {
        N.grid = Math.min(-net, N.gridAvail);       // solar first, then the backup feed, then the battery
        const d = -net - N.grid;
        this.soc -= d / this.c.eff * dtH / this.c.battKwh * 100;
        N.batt = d; N.curt = 0;
      }
      this.soc = clamp(this.soc, 0, 100);
      N.load = load;

      // Deliver energy, close finished sessions
      this.ports.forEach(p => {
        const u = p.s; if (!u) return;
        p.meas = p.set * (p.inject ? 1.35 : 1);
        const e = p.set * dtH * this.c.chgEff;
        u.kwh += e; this.m.kwh += e;
        u.soc = Math.min(100, u.soc + e / this.T[u.type].cap * 100);
      });
      this.ports.forEach(p => {
        const u = p.s; if (!u) return;
        if (u.soc >= u.target - 0.01) this.release(p, 'full');
        else if (this.smart && this.queue.length && !u.prio && (u.kwh >= (this.T[u.type].fair || this.c.fairKwh) || u.soc >= this.c.fairSoc)) this.release(p, 'fair');
      });

      // Converter temperature (first-order lag)
      const tT = 32 + 30 * Math.pow(load / this.c.busKw, 2) + (this.faults.fan ? 30 : 0);
      this.temp += (tT - this.temp) * Math.min(1, dt / 8);

      // What is limiting us, and how evenly power is shared
      if (N.demand <= N.budget + 0.01) N.limiter = 'none';
      else if (N.budget >= N.busLim - 0.01) N.limiter = this.hot && this.smart ? 'thermal' : 'bus';
      else if (N.gridAvail > 0) N.limiter = 'backup';
      else if (this.faults.bms) N.limiter = 'bms';
      else if (socD <= 0.01) N.limiter = 'reserve';
      else if (socD < 1) N.limiter = 'battery';
      else N.limiter = 'source';
      const xs = this.ports.filter(p => p.s && p.s.demand > 0).map(p => p.set / p.s.demand);
      const sx = xs.reduce((a, b) => a + b, 0), sx2 = xs.reduce((a, b) => a + b * b, 0);
      N.fair = xs.length >= 2 && sx2 > 0 ? sx * sx / (xs.length * sx2) : 1;
      if (xs.length >= 2 && sx2 > 0) { this.m.fairSum += N.fair * dt; this.m.fairN += dt; }

      this.m.pvKwh += N.pv * dtH; this.m.curtKwh += N.curt * dtH; this.m.gridKwh += N.grid * dtH;
      this.m.minSoc = Math.min(this.m.minSoc, this.soc);
      this.estimateWaits();
    }

    // Minutes left on a port before it frees up
    portLeft(p) {
      const u = p.s, T = this.T[u.type], N = this.now;
      const occ = Math.max(1, this.ports.filter(q => q.s).length);
      const fair = this.smart && !u.prio && this.queue.length > 0;
      let need = Math.max(0, ((fair ? Math.min(u.target, Math.max(this.c.fairSoc, u.soc)) : u.target) - u.soc) / 100 * T.cap);
      if (fair) need = Math.min(need, Math.max(0, (T.fair || this.c.fairKwh) - u.kwh));
      const pw = Math.max(p.set, 0.5 * Math.min(u.demand || T.max, N.budget / occ), 0.05) * this.c.chgEff;
      return need / pw * 60;
    }
    estimateWaits() {
      if (!this.queue.length) return;
      const N = this.now;
      const usable = this.ports.filter(p => !p.fault);
      if (!usable.length) { this.queue.forEach(u => { u.wait = Infinity; }); return; }
      const sunDelay = N.budget < 0.15 ? (this.t < 420 ? 420 - this.t : 1440 - this.t + 420) : 0;
      const free = usable.map(p => p.s ? this.portLeft(p) : 0);
      const occ = usable.filter(p => p.s).length;
      this.queue.forEach(u => {
        const T = this.T[u.type];
        let i = -1;                                  // the suitable port that frees up first
        for (let k = 0; k < free.length; k++) if ((!T.car || usable[k].car) && (i < 0 || free[k] < free[i])) i = k;
        if (i < 0) { u.wait = Infinity; return; }
        u.wait = free[i] + sunDelay + (this.tripped() ? this.tripUntil - this.abs() : 0);
        const need = Math.max(0, Math.min(T.fair || this.c.fairKwh, (Math.min(u.target, this.c.fairSoc) - u.soc) / 100 * T.cap));
        const pw = Math.max(0.1, Math.min(T.max, Math.max(N.budget, 0.5) / Math.min(usable.length, occ + 1))) * this.c.chgEff;
        free[i] += need / pw * 60;
      });
    }
  }

  /* Alarm list for the SCADA view: each entry names the problem, its probable cause and what the controller did. */
  function conditions(st) {
    const N = st.now, out = [];
    const why = {
      bus: 'More ' + st.c.noun + 's connected than the converter rating can feed',
      thermal: 'Converter is running derated because it is hot',
      source: 'Sun plus the battery discharge limit cannot cover every ' + st.c.noun,
      battery: 'Battery is low, so its support is being reduced',
      reserve: 'Battery is at its reserve floor: only solar power is available',
      bms: 'Battery is offline: only solar power is available',
      backup: 'Battery is low or offline: the station is on solar plus the ' + st.c.gridKw + ' kW backup feed'
    };
    if (!st.smart && N.tripped) out.push({ id: 'A-100', sev: 'crit', title: 'Bus overload: station tripped', cause: 'Connected demand rose above what the sun, battery or converter could supply and nothing limited it', action: 'None available. All ports are off for ' + st.c.tripMin + ' min and one ' + st.c.noun + ' must unplug' });
    if (st.smart && N.limiter !== 'none') out.push({ id: 'A-101', sev: 'info', title: 'Demand exceeds available power', cause: why[N.limiter], action: 'Load sharing active: every port throttled to its fair share, no trip' });
    if (st.soc < st.c.socDerate && st.soc > st.c.socFloor + 0.6 && !st.faults.bms) out.push({ id: 'A-201', sev: 'warn', title: 'Battery low', cause: 'Evening or cloudy operation has drawn the pack below ' + st.c.socDerate + '%', action: st.smart ? 'Battery support derated in proportion; ports re-shared' : 'None: battery keeps discharging at full rate' });
    if (st.soc <= st.c.socFloor + 0.6 && !st.faults.bms) out.push({ id: 'A-202', sev: 'serious', title: 'Battery at reserve floor', cause: 'Pack has reached the ' + st.c.socFloor + '% reserve that protects cell life', action: 'Battery discharge blocked; charging continues on solar' + (N.gridAvail > 0 ? ' and the backup feed' : ' only') });
    if (st.faults.bms) out.push({ id: 'A-203', sev: 'crit', title: 'Battery offline (BMS fault)', cause: 'BMS opened the pack contactor: cell over-voltage, over-temperature or a wiring fault', action: st.smart ? 'Station continues on solar only; ports re-shared to the new budget' : 'None: load is dumped onto the PV input' });
    if (N.exp > 1 && N.pv < 0.6 * N.exp) out.push({ id: 'A-301', sev: 'warn', title: 'PV output below expected', cause: st.faults.pvString && st.cloud < 0.45 ? 'Output is about half of the clear-sky value: one PV string is open, shaded or heavily soiled' : 'Heavy cloud cover (irradiance sensor confirms low light)', action: st.smart ? 'Power budget lowered; ports re-shared; battery covers the gap within its limits' : 'None' });
    if (N.gridAvail > 0) out.push({ id: 'A-700', sev: 'info', title: 'Backup feed engaged', cause: st.faults.bms ? 'Battery is offline, so the backup feed is covering for it' : 'Battery fell to ' + st.c.gridOn + '%: sun and battery alone can no longer carry the load', action: 'Grid backup supplying up to ' + st.c.gridKw + ' kW after solar is used; released when the battery recovers to ' + st.c.gridOff + '%' });
    if (st.backup && st.faults.grid) out.push({ id: 'A-701', sev: 'serious', title: 'Backup feed unavailable (grid outage)', cause: 'No voltage on the grid side of the backup rectifier: utility outage or a tripped incomer', action: st.smart ? 'Station continues on solar and battery only; budget lowered and ports re-shared' : 'None' });
    st.ports.forEach(p => {
      if (p.fault === 'oc') out.push({ id: 'A-40' + p.id, sev: 'crit', title: 'Port ' + p.id + ' overcurrent', cause: 'Measured current was 35% above the commanded setpoint: faulty charger or damaged cable', action: 'Port relay opened and latched; ' + st.c.noun + ' moved to the front of the queue; operator reset required' });
      if (!p.comms) out.push({ id: 'A-41' + p.id, sev: 'serious', title: 'Port ' + p.id + ' current sensor lost', cause: 'No reading from the port sensor on the I2C/CAN bus: loose connector or failed sensor', action: st.smart ? 'Port held at minimum safe power until feedback returns' : 'None' });
    });
    if (st.hot) out.push({ id: 'A-501', sev: 'serious', title: 'Converter over-temperature', cause: 'Heatsink above ' + st.c.hotC + ' °C: cooling fan failure or blocked vent', action: st.smart ? 'Station limit derated to 60% until it cools below ' + (st.c.hotC - 5) + ' °C' : 'None until the thermal cut-out trips the station' });
    const w = st.queue.reduce((mx, u) => Math.max(mx, isFinite(u.wait) ? u.wait : 999), 0);
    if (st.queue.length >= 3 && w > 90) out.push({ id: 'A-601', sev: 'info', title: 'Long queue', cause: 'Arrivals are outpacing the energy the site can deliver', action: 'Fair-use cap applied to every session; logged for capacity planning (add PV or ports)' });
    return out;
  }
  class Alarms {
    constructor() { this.list = []; this.active = new Map(); }
    update(st) {
      const abs = st.abs(), seen = new Set();
      conditions(st).forEach(c => {
        seen.add(c.id);
        let a = this.active.get(c.id);
        if (!a) { a = Object.assign({ t: st.t, state: 'ACTIVE', ack: false }, c); this.active.set(c.id, a); this.list.unshift(a); if (this.list.length > 24) this.list.pop(); }
        else { a.title = c.title; a.cause = c.cause; a.action = c.action; }
        a.last = abs;
      });
      this.active.forEach((a, id) => { if (!seen.has(id) && (abs - a.last > 3 || abs < a.last)) { a.state = 'CLEARED'; this.active.delete(id); } });
    }
  }

  /* Same arrivals, same weather, both control modes: the before/after table on the Problem tab. */
  function runDays(smart, days) {
    const sum = { kwh: 0, served: 0, trips: 0, downMin: 0, waitSum: 0, waitN: 0, waitMax: 0, curtKwh: 0, turned: 0, pvKwh: 0, minSoc: 0, arrived: 0, left: 0, gridKwh: 0 };
    for (let d = 0; d < days; d++) {
      const st = new Station({ smart: smart, seed: 100 + d * 7, startMin: 360, auto: true });
      st.soc = 50;
      for (let i = 0; i < 1440; i++) {
        const base = d % 4 === 3 ? 0.5 : 0.1;
        st.cloud = st.t >= 750 && st.t < 810 ? Math.max(base, 0.7) : base;
        st.step(1);
      }
      const m = st.m;
      sum.kwh += m.kwh; sum.served += m.served; sum.trips += m.trips; sum.downMin += m.downMin;
      sum.waitSum += m.waitSum; sum.waitN += m.waitN; sum.waitMax += m.waitMax;
      sum.curtKwh += m.curtKwh; sum.turned += m.turned; sum.pvKwh += m.pvKwh; sum.gridKwh += m.gridKwh; sum.minSoc += m.minSoc; sum.arrived += st.seq; sum.left += st.queue.length;
    }
    return {
      kwh: sum.kwh / days, served: sum.served / days, trips: sum.trips / days, downMin: sum.downMin / days,
      avgWait: sum.waitN ? sum.waitSum / sum.waitN : 0, maxWait: sum.waitMax / days,
      curtKwh: sum.curtKwh / days, turned: sum.turned / days, pvKwh: sum.pvKwh / days, gridKwh: sum.gridKwh / days, minSoc: sum.minSoc / days, arrived: sum.arrived / days, stillWaiting: sum.left / days
    };
  }

  root.SS = { CFG: CFG, TYPES: TYPES, Station: Station, Alarms: Alarms, shareOut: shareOut, runDays: runDays, arrivalRate: arrivalRate };
})(typeof window !== 'undefined' ? window : globalThis);
