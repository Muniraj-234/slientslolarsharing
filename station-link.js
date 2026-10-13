/* Link between the station and the customer app.
   The app only ever sees a plain snapshot of the station and sends it commands (check in, leave).
   Here the snapshot travels over a BroadcastChannel between browser tabs; a deployed station would
   publish the same snapshot over MQTT or a REST endpoint and the app would not change. */
(function (root) {
  'use strict';
  const CH = 'silent-assistant-station';

  function snapshot(st, src) {
    const N = st.now, c = st.c;
    // Wait for someone arriving now: behind everyone already queued for the same kind of port,
    // on the suitable port that frees up next. -1 means "cannot be estimated".
    const waitFor = car => {
      const ok = st.ports.filter(p => !p.fault && (!car || p.car));
      if (!ok.length) return -1;
      const left = ok.map(p => p.s ? st.portLeft(p) : 0).sort((x, y) => x - y);
      const pos = st.queue.filter(u => !car || st.T[u.type].car).length;
      if (st.smart) return left[Math.min(pos, ok.length - 1)] + Math.floor(pos / ok.length) * 45;
      return !N.tripped && !pos && left[0] === 0 ? 0 : -1;
    };
    return {
      src: src, t: st.t, day: st.day, smart: st.smart, tripped: !!N.tripped, tripLeft: N.tripLeft || 0,
      pv: N.pv, budget: N.budget, load: N.load, batt: N.batt, grid: N.grid, gridAvail: N.gridAvail,
      soc: st.soc, cloud: st.cloud, limiter: N.limiter, waitNew: waitFor(false), waitCar: waitFor(true),
      cfg: { ports: c.ports, portMax: c.portMax, carMax: c.carMax, busKw: c.busKw, gridKw: c.gridKw, pvKwp: c.pvKwp, pvDerate: c.pvDerate, arrX: c.arrX, chgEff: c.chgEff, fairKwh: c.fairKwh, fairSoc: c.fairSoc, queueMax: c.queueMax },
      ports: st.ports.map(p => {
        const u = p.s;
        return { id: p.id, car: p.car, max: p.max, state: p.fault ? 'fault' : u ? u.state : 'free', set: p.set, token: u ? u.token : null, type: u ? u.type : null,
          prio: !!(u && u.prio), soc: u ? u.soc : 0, target: u ? u.target : 0, kwh: u ? u.kwh : 0, left: u ? st.portLeft(p) : 0 };
      }),
      queue: st.queue.map(u => ({ token: u.token, type: u.type, prio: u.prio, soc: u.soc, wait: isFinite(u.wait) ? u.wait : -1 }))
    };
  }

  function handle(st, cmd) {
    if (cmd.kind === 'checkin') {
      if (!st.T[cmd.type]) return { ok: false, why: 'Unknown vehicle type' };
      const u = st.arrive(cmd.type, !!cmd.prio, cmd.soc);
      if (!u) return { ok: false, why: 'The queue is full. Please try again in a few minutes.' };
      u.target = cmd.target; u.booked = !!cmd.prio;
      return { ok: true, token: u.token };
    }
    if (cmd.kind === 'leave') { st.leave(cmd.token); return { ok: true }; }
    return { ok: false, why: 'Unknown command' };
  }

  // Station side: publish snapshots (at most twice a second) and act on commands from the app.
  function serve(getStation, after) {
    if (!('BroadcastChannel' in root)) return { publish: function () {} };
    const ch = new BroadcastChannel(CH);
    let last = 0;
    ch.onmessage = e => {
      const m = e.data;
      if (!m || m.kind !== 'cmd') return;
      const r = handle(getStation(), m.cmd);
      ch.postMessage({ kind: 'reply', id: m.id, r: r });
      if (after) after();
    };
    return {
      publish: function () {
        const now = Date.now(); if (now - last < 500) return; last = now;
        ch.postMessage({ kind: 'snap', snap: snapshot(getStation(), 'dashboard') });
      }
    };
  }

  root.SSLink = { CH: CH, snapshot: snapshot, handle: handle, serve: serve };
})(typeof window !== 'undefined' ? window : globalThis);
