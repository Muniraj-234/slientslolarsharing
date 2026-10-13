/* Silent Assassins 3D views: the live station and the bench prototype, built from primitives with three.js.
   Both read the same Station object the rest of the page uses, so nothing here has its own state to drift. */
(function () {
  'use strict';

  // Tried in order: CDN, then a local copy in vendor/ so the page also works without internet.
  const SRC = [
    ['https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js', 'vendor/three.min.js'],
    ['https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js', 'vendor/OrbitControls.js']
  ];
  const COL = { pv: '#eb6834', batt: '#1baf7a', load: '#2a78d6', grid: '#9085e9', good: '#0ca30c', warn: '#fab219', serious: '#ec835a', crit: '#d03b3b', idle: '#8a8a8a' };
  const LAMP = { free: COL.idle, full: COL.good, shared: COL.load, hold: COL.warn, trip: COL.warn, fault: COL.crit };
  const SL = { free: 'free', full: 'full power', shared: 'sharing', hold: 'on hold', trip: 'tripped', fault: 'isolated' };

  let THREE, S = null, hooks = {}, started = false, last = 0;
  const views = [];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const dur = m => { if (!isFinite(m)) return 'not known'; const n = Math.round(m); return n < 1 ? 'under 1 min' : n < 60 ? n + ' min' : Math.floor(n / 60) + ' h ' + String(n % 60).padStart(2, '0') + ' m'; };
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function script(src) {
    return new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
  }
  async function loadLib() {
    if (!window.THREE) { try { await script(SRC[0][0]); } catch (e) { await script(SRC[0][1]); } }
    if (!window.THREE.OrbitControls) { try { await script(SRC[1][0]); } catch (e) { await script(SRC[1][1]); } }
    THREE = window.THREE;
  }

  /* ---------- small builders ---------- */
  const lin = {}, mats = {};
  const C = hex => lin[hex] || (lin[hex] = new THREE.Color(hex).convertSRGBToLinear());   // colours are authored in sRGB
  function M(hex, rough, metal) {
    const k = hex + '|' + rough + '|' + metal;
    return mats[k] || (mats[k] = new THREE.MeshStandardMaterial({ color: C(hex).clone(), roughness: rough == null ? 0.7 : rough, metalness: metal || 0 }));
  }
  const glow = (hex, k) => new THREE.MeshStandardMaterial({ color: C('#15191c').clone(), emissive: C(hex).clone(), emissiveIntensity: k == null ? 1 : k, roughness: 0.5 });
  function add(mesh, x, y, z, parent) { mesh.position.set(x || 0, y || 0, z || 0); mesh.castShadow = mesh.receiveShadow = true; if (parent) parent.add(mesh); return mesh; }
  const box = (w, h, d, m, x, y, z, parent) => add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m), x, y, z, parent);
  const cyl = (r, h, m, x, y, z, parent, seg) => add(new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg || 16), m), x, y, z, parent);
  function wheel(r, w, x, y, z, parent) { const c = cyl(r, w, M('#1c1f22', 0.9), x, y, z, parent, 18); c.rotation.z = Math.PI / 2; return c; }
  function bar(a, b, r, m, parent) {          // thin rod between two points
    const A = new THREE.Vector3(a[0], a[1], a[2]), B = new THREE.Vector3(b[0], b[1], b[2]);
    const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, A.distanceTo(B), 8), m);
    c.position.copy(A).add(B).multiplyScalar(0.5);
    c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
    c.castShadow = true; parent.add(c); return c;
  }
  // tension 0 gives straight runs with square corners (wiring); 0.5 gives a hanging cable
  const path = (pts, tension) => new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(p[0], p[1], p[2])), false, 'catmullrom', tension || 0);
  function tube(curve, r, m, parent) { const t = new THREE.Mesh(new THREE.TubeGeometry(curve, curve.points.length * 12, r, 6, false), m); t.castShadow = true; parent.add(t); return t; }

  // Moving dots along a wire: speed and density follow the power in that wire.
  function Flow(curve, hex, n, r, speed, parent) {
    const g = new THREE.SphereGeometry(r, 8, 6), m = new THREE.MeshBasicMaterial({ color: C(hex).clone(), fog: false });
    this.curve = curve; this.len = curve.getLength(); this.speed = speed; this.ph = Math.random(); this.dots = [];
    for (let i = 0; i < n; i++) { const d = new THREE.Mesh(g, m); d.visible = false; parent.add(d); this.dots.push(d); }
  }
  Flow.prototype.set = function (dt, kw, ref, reverse) {
    const n = this.dots.length, on = kw > 0.02, k = Math.min(1, kw / ref);
    if (on) this.ph = (this.ph + (reverse ? -1 : 1) * dt * this.speed * (0.35 + 0.65 * k) / this.len + 1) % 1;
    const show = on ? Math.max(2, Math.round(n * (0.4 + 0.6 * k))) : 0;
    for (let i = 0; i < n; i++) { const d = this.dots[i]; d.visible = i < show; if (i < show) this.curve.getPointAt((this.ph + i / show) % 1, d.position); }
  };
  Flow.prototype.dispose = function () { this.dots.forEach(d => d.parent && d.parent.remove(d)); };

  // Two-line tag that always faces the camera. Redrawn only when its text changes.
  function Label(scale, parent, x, y, z) {
    this.cv = document.createElement('canvas'); this.cv.width = 384; this.cv.height = 96;
    this.tex = new THREE.CanvasTexture(this.cv); this.tex.encoding = THREE.sRGBEncoding;
    this.sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, depthTest: false, transparent: true, fog: false }));
    this.sp.scale.set(scale, scale / 4, 1); this.sp.renderOrder = 10; this.sp.position.set(x, y, z); parent.add(this.sp);
    this.key = null;
  }
  Label.prototype.set = function (a, b, hex) {
    const key = a + '|' + b + '|' + hex; if (key === this.key) return; this.key = key;
    const g = this.cv.getContext('2d');
    g.clearRect(0, 0, 384, 96);
    g.fillStyle = 'rgba(10,10,10,.9)'; g.fillRect(0, 0, 384, 96);
    g.fillStyle = hex || COL.idle; g.fillRect(0, 0, 10, 96);
    g.textBaseline = 'middle'; g.fillStyle = '#f5f5f5';
    g.font = '600 ' + (b ? 32 : 50) + 'px "IBM Plex Mono", Consolas, monospace'; g.fillText(a, 24, b ? 30 : 50, 348);   // one-line tags get larger type
    if (b) { g.fillStyle = '#c4c4c4'; g.font = '500 24px "IBM Plex Mono", Consolas, monospace'; g.fillText(b, 24, 70, 348); }
    this.tex.needsUpdate = true;
  };

  // A text display (kiosk screen, LCD module) drawn to a texture.
  function Screen(w, h, bg, fg, px) {
    this.cv = document.createElement('canvas'); this.cv.width = w; this.cv.height = h;
    this.tex = new THREE.CanvasTexture(this.cv); this.tex.encoding = THREE.sRGBEncoding;
    this.bg = bg; this.fg = fg; this.px = px; this.key = null;
  }
  Screen.prototype.set = function (lines) {
    const key = lines.join('\n'); if (key === this.key) return; this.key = key;
    const g = this.cv.getContext('2d'), w = this.cv.width, h = this.cv.height, row = h / lines.length;
    g.fillStyle = this.bg; g.fillRect(0, 0, w, h);
    g.fillStyle = this.fg; g.textBaseline = 'middle'; g.font = '600 ' + this.px + 'px "IBM Plex Mono", Consolas, monospace';
    lines.forEach((t, i) => g.fillText(t, this.px * 0.7, row * (i + 0.5), w - this.px * 1.4));
    this.tex.needsUpdate = true;
  };

  function cellTexture() {
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128;
    const g = cv.getContext('2d');
    g.fillStyle = '#c9ced1'; g.fillRect(0, 0, 256, 128);
    g.fillStyle = '#10233f'; g.fillRect(5, 5, 246, 118);
    g.strokeStyle = '#2c4d7c'; g.lineWidth = 1.5; g.beginPath();
    for (let i = 1; i < 12; i++) { g.moveTo(5 + i * 20.5, 5); g.lineTo(5 + i * 20.5, 123); }
    for (let j = 1; j < 6; j++) { g.moveTo(5, 5 + j * 19.7); g.lineTo(251, 5 + j * 19.7); }
    g.stroke();
    const t = new THREE.CanvasTexture(cv); t.encoding = THREE.sRGBEncoding; t.anisotropy = 4; return t;
  }

  /* ---------- a canvas, camera and orbit control in one host element ---------- */
  function View(host, o) {
    const v = this;
    v.host = host; v.picks = []; v.dirty = true; v.w = 0; v.h = 0; v.fov = o.fov;
    v.renderer = new THREE.WebGLRenderer({ antialias: true });
    v.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    v.renderer.outputEncoding = THREE.sRGBEncoding;
    v.renderer.shadowMap.enabled = true; v.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const cv = v.renderer.domElement;
    cv.setAttribute('aria-hidden', 'true');
    host.insertBefore(cv, host.firstChild);
    v.scene = new THREE.Scene();
    v.camera = new THREE.PerspectiveCamera(o.fov, 2, o.near, o.far);
    v.camera.position.set(o.cam[0], o.cam[1], o.cam[2]);
    v.controls = new THREE.OrbitControls(v.camera, cv);
    v.controls.target.set(o.target[0], o.target[1], o.target[2]);
    v.controls.enableDamping = true; v.controls.dampingFactor = 0.08;
    v.controls.maxPolarAngle = 1.53; v.controls.minDistance = o.min; v.controls.maxDistance = o.max;
    v.controls.autoRotateSpeed = 0.7;
    v.controls.enableZoom = false;                      // the wheel scrolls the page until the view is clicked
    cv.addEventListener('pointerdown', () => { v.controls.enableZoom = true; });
    cv.addEventListener('pointerleave', () => { v.controls.enableZoom = false; });
    v.controls.update(); v.controls.saveState();
  }
  View.prototype.fit = function () {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h || this.host.offsetParent === null) return false;     // tab is hidden
    if (w !== this.w || h !== this.h) { this.w = w; this.h = h; this.renderer.setSize(w, h, false);
      const a = w / h, half = Math.tan(this.fov * Math.PI / 360);          // on narrow screens widen the lens so the whole scene still fits
      this.camera.fov = Math.min(78, Math.atan(half * Math.max(1, 1.7 / a)) * 360 / Math.PI);
      this.camera.aspect = a; this.camera.updateProjectionMatrix();
    }
    return true;
  };
  // Hover a part to read what it is; parts with a click action behave as buttons.
  View.prototype.enablePicking = function () {
    const v = this, cv = v.renderer.domElement, ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), tip = v.host.querySelector('.tip');
    let cur = null, down = null, at = [0, 0];
    const find = e => {
      const r = cv.getBoundingClientRect();
      at = [e.clientX - r.left, e.clientY - r.top];
      ndc.set(at[0] / r.width * 2 - 1, -at[1] / r.height * 2 + 1);
      ray.setFromCamera(ndc, v.camera);
      const hit = ray.intersectObjects(v.picks, true)[0];
      let o = hit && hit.object; while (o && !o.userData.info) o = o.parent;
      return o || null;
    };
    const select = o => {
      if (o === cur) return; cur = o;
      if (v.hl) { v.scene.remove(v.hl); v.hl = null; }
      if (o) { v.hl = new THREE.BoxHelper(o, 0xfab219); v.scene.add(v.hl); }
      cv.style.cursor = o ? (o.userData.info.click ? 'pointer' : 'help') : '';
    };
    v.refreshTip = () => {
      if (!cur) { tip.hidden = true; return; }
      const i = cur.userData.info;
      tip.innerHTML = '';
      const b = document.createElement('b'); b.textContent = i.name; tip.appendChild(b);
      tip.appendChild(document.createTextNode(i.role));
      if (i.live && S) { const s = document.createElement('span'); s.textContent = i.live(); tip.appendChild(s); }
      tip.hidden = false;
      tip.style.left = Math.max(4, at[0] > v.w - 290 ? at[0] - tip.offsetWidth - 14 : at[0] + 14) + 'px';
      tip.style.top = Math.max(4, Math.min(v.h - tip.offsetHeight - 4, at[1] + 14)) + 'px';
    };
    cv.addEventListener('pointermove', e => { if (e.buttons) { select(null); } else select(find(e)); v.refreshTip(); });
    cv.addEventListener('pointerleave', () => { select(null); v.refreshTip(); });
    cv.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
    cv.addEventListener('pointerup', e => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
      const o = find(e); if (o && o.userData.info.click) o.userData.info.click();
    });
  };

  /* =====================================================================
     Scene 1: the station. Units are metres; the camera stands south of the pad looking north.
     ===================================================================== */
  function buildStation(v) {
    const sc = v.scene, NP = S.c.ports, px = i => (i - (NP - 1) / 2) * 2, LANE = 6.3, PAD = 0.12;
    // The plant stands in a row off the west end of the canopy: controller, MPPT, battery bank, grid backup, utility pole.
    const HW = NP * 1.15, XC = -HW - 1.0, XM = XC - 1.2, XB = XM - 1.5, XB2 = XB - 1.3, XG = XB2 - 1.9, XP = XG - 3.2, XE = px(NP - 1) + 1.6;
    const steel = M('#8d979c', 0.45, 0.6), eq = M('#d5dadc', 0.6, 0.1), dark = M('#30393e', 0.75);
    const glass = new THREE.MeshStandardMaterial({ color: C('#bcd3df').clone(), transparent: true, opacity: 0.35, roughness: 0.1 });

    // sky, sun and night lamps
    const NIGHT = new THREE.Color('#0c1522'), DAY = new THREE.Color('#a9d3ee'), DUSK = new THREE.Color('#f0a66a'), GREY = new THREE.Color('#b4bcc0');
    const WARM = new THREE.Color('#ffb070'), WHITE = new THREE.Color('#ffffff'), sky = new THREE.Color(), dir = new THREE.Vector3();
    sc.background = new THREE.Color(); sc.fog = new THREE.Fog(0x000000, 55, 190);
    const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8172, 0.6); sc.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -(HW + 14), right: HW + 8, top: 16, bottom: -16, near: 1, far: 160 });
    sun.shadow.camera.updateProjectionMatrix(); sun.shadow.bias = -0.0006; sc.add(sun); sc.add(sun.target);
    const sunBall = new THREE.Mesh(new THREE.SphereGeometry(3.5, 20, 14), new THREE.MeshBasicMaterial({ color: 0xffd98a, fog: false })); sc.add(sunBall);
    const lamps = [-0.66, -0.22, 0.22, 0.66].map(k => { const l = new THREE.PointLight(0xffe2b0, 0, 16, 2); l.position.set(k * HW, 3, 0.8); sc.add(l); return l; });

    // ground, pad, lane
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), M('#a39b86', 1)); ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; sc.add(ground);
    box(XE - XG + 1.3, PAD, 6.4, M('#aab0b2', 0.9), (XE + XG - 1.3) / 2, PAD / 2, 1.2, sc);
    box(140, 0.04, 5.6, M('#6c7376', 0.95), 0, 0.02, 7.7, sc);
    for (let x = -66; x < 68; x += 3) box(1.4, 0.01, 0.1, M('#e9e9e2', 0.9), x, 0.045, 7.75, sc);
    for (let i = 0; i <= NP; i++) box(0.06, 0.01, 2.9, M('#f3f3ee', 0.9), px(i) - 1, PAD + 0.006, 2.3, sc);
    [[-28, -8], [-18, -11], [-8, -9], [3, -10], [12, -8], [19, -5], [22, 2], [-29, 3]].forEach((p, i) => {
      cyl(0.16, 1.6, M('#6b5642', 0.9), p[0], 0.8, p[1], sc, 8);
      add(new THREE.Mesh(new THREE.ConeGeometry(1.3 + (i % 2) * 0.3, 2.6, 8), M('#4f7a4a', 0.9)), p[0], 2.6, p[1], sc);
      add(new THREE.Mesh(new THREE.ConeGeometry(0.95, 2, 8), M('#5b8a54', 0.9)), p[0], 3.9, p[1], sc);
    });
    const clouds = [], cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0, roughness: 1, depthWrite: false, fog: false });
    for (let i = 0; i < 9; i++) {
      const g = new THREE.Group();
      for (let j = 0; j < 4; j++) { const m = new THREE.Mesh(new THREE.SphereGeometry(2.2 + ((i + j) % 3) * 0.7, 10, 8), cloudMat); m.position.set(j * 2.6 - 4, (j % 2) * 0.8, (j % 3) - 1); m.scale.y = 0.55; g.add(m); }
      g.position.set(-58 + i * 14, 11 + (i % 3) * 2.4, -34 - (i % 4) * 7); sc.add(g); clouds.push(g);
    }

    // solar canopy: two panels per bay in two strings, tilted south
    const tilt = 0.2, roofY = 3.3, roofZ = 0.4, cols = NP;
    const roof = new THREE.Group(); roof.position.set(0, roofY, roofZ); roof.rotation.x = tilt; sc.add(roof);
    const pvTex = cellTexture(), panels = [];
    for (let c = 0; c < cols; c++) for (let r = 0; r < 2; r++) {
      const m = new THREE.MeshStandardMaterial({ map: pvTex, roughness: 0.28, metalness: 0.35 });
      const p = box(2.2, 0.05, 1.1, m, (c - (cols - 1) / 2) * 2.3, 0, (r - 0.5) * 1.16, roof); p.userData.stringB = r === 0; panels.push(p);
    }
    [-0.85, 0.85].forEach(z => box(cols * 2.3 + 0.2, 0.1, 0.1, steel, 0, -0.09, z, roof));
    const mid = Math.round(HW / 6) * 2;      // inner posts stand on bay lines
    (NP > 6 ? [-HW + 0.2, -mid, mid, HW - 0.2] : [-HW + 0.2, HW - 0.2]).forEach(x => [-0.5, 1.3].forEach(z => { const top = roofY - (z - roofZ) * Math.sin(tilt) - 0.12; cyl(0.07, top, steel, x, top / 2, z, sc, 10); }));

    // plant: battery bank (two cabinets), MPPT / converter, controller with kiosk screen
    const segOn = glow(COL.batt, 1.1), segOff = M('#4a5459', 0.8), segs = [];
    [XB, XB2].forEach(x => {
      box(1.2, 1.7, 0.7, eq, x, PAD + 0.85, -0.6, sc);
      box(1.0, 0.12, 0.02, dark, x, PAD + 1.52, -0.24, sc);
      for (let k = 0; k < 10; k++) segs.push(box(0.5, 0.1, 0.03, segOff, x, PAD + 0.2 + k * 0.125, -0.235, sc));
    });
    box(0.8, 1.3, 0.5, eq, XM, PAD + 0.65, -0.6, sc);
    for (let k = 0; k < 5; k++) box(0.05, 0.9, 0.3, dark, XM - 0.28 + k * 0.14, PAD + 0.75, -0.9, sc);
    const mpptLamp = box(0.16, 0.08, 0.02, glow(COL.idle, 1), XM, PAD + 1.1, -0.34, sc);
    box(0.75, 1.6, 0.4, M('#1c1f22', 0.5), XC, PAD + 0.8, -0.6, sc);
    const kiosk = new Screen(320, 224, '#0a0a0a', '#f5f5f5', 28);
    add(new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.42), new THREE.MeshBasicMaterial({ map: kiosk.tex })), XC, PAD + 1.2, -0.395, sc);
    const beacon = cyl(0.09, 0.14, glow(COL.good, 1.3), XC, PAD + 1.67, -0.6, sc, 12);

    // backup power: utility pole and transformer, service drop, rectifier cabinet feeding the DC bus
    box(0.95, 1.5, 0.55, eq, XG, PAD + 0.75, -0.6, sc);
    box(0.95, 0.16, 0.02, M(COL.grid, 0.5), XG, PAD + 1.32, -0.315, sc);
    const gridLamp = box(0.2, 0.1, 0.02, glow(COL.idle, 1), XG, PAD + 1.05, -0.315, sc);
    const wood = M('#75624f', 0.9);
    cyl(0.13, 7.4, wood, XP, 3.7, -2.2, sc, 10); box(0.12, 0.12, 2.2, wood, XP, 7.0, -2.2, sc);
    [-0.9, 0, 0.9].forEach(z => { cyl(0.06, 0.22, M('#d8d2c4', 0.5), XP, 7.17, -2.2 + z, sc, 8); bar([XP, 7.28, -2.2 + z], [XP - 70, 7.28, -2.2 + z], 0.018, dark, sc); });
    cyl(0.4, 1.0, M('#7f8a8f', 0.5, 0.4), XP + 0.6, 5.4, -2.2, sc, 14); box(0.5, 0.1, 0.3, steel, XP + 0.3, 5.4, -2.2, sc);
    const drop = path([[XP + 0.6, 4.9, -2.2], [(XP + XG) / 2 + 0.3, 3.1, -1.4], [XG, PAD + 1.5, -0.6]], 0.5);
    const gridRun = path([[XG, 0.5, -0.3], [XG, 0.3, 0.22], [XM, 0.3, 0.22], [XM, 0.8, -0.3]]);
    tube(drop, 0.03, dark, sc);

    const gridLabel = new Label(3.4, sc, XG - 0.9, 2.6, -0.6), battLabel = new Label(3.4, sc, XB2, 3.5, -0.6), mpptLabel = new Label(3.4, sc, XM - 0.3, 4.4, -0.6),
      ctlLabel = new Label(3.4, sc, XC - 0.5, 5.3, -0.6), pvLabel = new Label(3.8, sc, 1, 6.5, 0.2);

    // conduits and the 48 V bus trunk
    const pvPath = path([[-HW + 0.2, 3.45, -0.5], [-HW + 0.2, 0.3, -0.5], [-HW + 0.2, 0.3, 0.02], [XM, 0.3, 0.02], [XM, 0.95, -0.3]]);
    const battPath = path([[XB2, 0.5, -0.2], [XM, 0.5, -0.2]]);
    const busPath = path([[XM, 0.3, -0.16], [XC, 0.3, -0.16], [XC, 0.3, -0.45]]);
    [pvPath, battPath, busPath, gridRun].forEach(p => tube(p, 0.035, dark, sc));
    box(XE - 0.85 - XC, 0.1, 0.16, dark, (XE - 1.15 + XC) / 2, PAD + 0.05, -0.45, sc);
    const pvFlow = new Flow(pvPath, COL.pv, 12, 0.075, 3.2, sc), battFlow = new Flow(battPath, COL.batt, 5, 0.075, 2.2, sc), busFlow = new Flow(busPath, COL.load, 4, 0.075, 2.6, sc);
    const gridFlow = new Flow(gridRun, COL.grid, 8, 0.075, 2.8, sc), dropFlow = new Flow(drop, COL.grid, 5, 0.075, 2.8, sc);

    // charging pedestals
    const ports = [];
    for (let i = 0; i < NP; i++) {
      const x = px(i), ly = i % 2 ? 4.2 : 5.2;          // signboards above the canopy, staggered so neighbours do not overlap
      const car = !!S.ports[i].car, ph = car ? 1.45 : 1.2;   // car bays: taller pedestal in the brand colour on a painted bay
      box(0.34, ph, 0.24, car ? M('#1c1f22', 0.5) : eq, x, PAD + ph / 2, 0, sc);
      if (car) box(1.9, 0.012, 3.6, M('#86b3a2', 0.9), x, PAD + 0.004, 2.5, sc);
      box(0.1, 0.8, 0.02, dark, x, PAD + 0.65, 0.125, sc);
      const fg = new THREE.BoxGeometry(0.08, 0.8, 0.02); fg.translate(0, 0.4, 0);
      const fill = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color: C(COL.load).clone() })); fill.position.set(x, PAD + 0.25, 0.13); sc.add(fill);
      box(0.06, 0.1, 0.16, dark, x, PAD + 0.17, -0.25, sc);
      bar([x, PAD + ph + 0.1, 0], [x, ly - 0.46, 0.4], 0.012, dark, sc);
      const fp = path([[XC, 0.3, -0.45], [x, 0.3, -0.45], [x, 0.3, -0.16], [x, 1.0, -0.16]]);
      ports.push({
        x: x, state: 'free', kw: 0, fill: fill, max: S.ports[i].max,
        lamp: box(0.36, 0.1, 0.26, glow(COL.idle, 0.6), x, PAD + ph + 0.05, 0, sc),
        label: new Label(3.6, sc, x, ly, 0.4),
        flow: new Flow(fp, COL.load, 4 + Math.round(fp.getLength() / 1.4), 0.07, 3.4, sc)
      });
    }

    /* vehicles: local +z is the front; each returns where its charge socket is */
    const dk = M('#23272b', 0.8);
    const MAKE = {
      rick: function (g, hue) {
        const body = M(hue, 0.55);
        box(1.0, 0.45, 1.5, body, 0, 0.6, -0.35, g); box(0.9, 0.5, 0.06, body, 0, 1.05, -1.08, g);
        box(0.86, 0.1, 0.45, dk, 0, 0.88, -0.75, g); box(0.5, 0.1, 0.35, dk, 0, 0.88, 0.25, g);
        box(0.55, 0.65, 0.3, body, 0, 0.72, 0.85, g); box(0.7, 0.2, 0.5, dk, 0, 0.3, -0.45, g);
        add(new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.6, 0.04), glass), 0, 1.38, 0.9, g).rotation.x = -0.18;
        box(1.08, 0.06, 2.2, M('#e8e1c9', 0.7), 0, 1.75, -0.05, g);
        [[-0.48, -1.05], [0.48, -1.05], [-0.42, 0.92], [0.42, 0.92]].forEach(p => bar([p[0], 0.8, p[1]], [p[0], 1.74, p[1]], 0.025, steel, g));
        wheel(0.23, 0.1, 0, 0.23, 1.15, g); wheel(0.23, 0.1, -0.55, 0.23, -0.7, g); wheel(0.23, 0.1, 0.55, 0.23, -0.7, g);
        bar([0, 0.25, 1.15], [0, 1.0, 0.85], 0.03, steel, g); bar([-0.3, 1.0, 0.82], [0.3, 1.0, 0.82], 0.025, dk, g);
        return { plug: [0.3, 0.55, -1.1], top: 1.8, z: 1.75, len: 2.5 };
      },
      scoot: function (g, hue) {
        const body = M(hue, 0.5);
        wheel(0.2, 0.1, 0, 0.2, 0.62, g); wheel(0.2, 0.1, 0, 0.2, -0.6, g);
        box(0.3, 0.07, 0.6, dk, 0, 0.3, 0.02, g); box(0.34, 0.36, 0.72, body, 0, 0.5, -0.5, g); box(0.3, 0.08, 0.66, dk, 0, 0.73, -0.45, g);
        box(0.36, 0.62, 0.07, body, 0, 0.6, 0.42, g).rotation.x = -0.25;
        bar([0, 0.22, 0.62], [0, 1.02, 0.36], 0.03, steel, g); bar([-0.28, 1.02, 0.36], [0.28, 1.02, 0.36], 0.022, dk, g);
        box(0.16, 0.12, 0.08, M('#f4f0d0', 0.4), 0, 0.92, 0.43, g);
        return { plug: [0.19, 0.5, -0.75], top: 1.15, z: 1.35, len: 1.8 };
      },
      cycle: function (g, hue) {
        const body = M(hue, 0.5), A = [0, 0.35, -0.52], BB = [0, 0.32, -0.03], ST = [0, 0.84, -0.2], HT = [0, 0.88, 0.36], F = [0, 0.35, 0.52];
        [0.52, -0.52].forEach(z => { const t = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.028, 8, 24), dk); t.rotation.y = Math.PI / 2; add(t, 0, 0.35, z, g); });
        [[A, BB], [BB, ST], [ST, A], [ST, HT], [BB, HT], [HT, F]].forEach(s => bar(s[0], s[1], 0.022, body, g));
        box(0.12, 0.05, 0.26, dk, 0, 0.88, -0.22, g); bar([-0.26, 1.0, 0.36], [0.26, 1.0, 0.36], 0.018, dk, g); bar(HT, [0, 1.0, 0.36], 0.018, steel, g);
        box(0.08, 0.1, 0.36, M('#2b3338', 0.6), 0, 0.6, 0.165, g).rotation.x = -0.96;
        return { plug: [0.06, 0.6, 0], top: 1.1, z: 1.25, len: 1.8 };
      },
      phone: function (g, hue) {       // a person charging a phone at the locker port
        cyl(0.09, 0.8, dk, -0.1, 0.4, 0, g, 8); cyl(0.09, 0.8, dk, 0.1, 0.4, 0, g, 8);
        box(0.42, 0.6, 0.24, M(hue, 0.8), 0, 1.1, 0, g);
        add(new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 10), M('#c68c5e', 0.8)), 0, 1.58, 0, g);
        box(0.09, 0.16, 0.02, M('#101214', 0.3), 0.26, 1.05, 0.14, g);
        return { plug: [0.26, 1.0, 0.1], top: 1.75, z: 0.95, len: 0.9 };
      },
      car: function (g, hue) {         // compact city EV, 3.2 m long
        const body = M(hue, 0.35, 0.3), win = M('#16222b', 0.15, 0.2);
        box(1.5, 0.52, 3.2, body, 0, 0.56, 0, g);
        box(1.36, 0.46, 1.75, win, 0, 1.03, -0.2, g); box(1.4, 0.07, 1.55, body, 0, 1.29, -0.2, g);
        [[-0.66, 0.62], [0.66, 0.62], [-0.66, -1.02], [0.66, -1.02]].forEach(p => bar([p[0], 0.8, p[1]], [p[0], 1.28, p[1] + (p[1] > 0 ? -0.12 : 0.1)], 0.045, body, g));
        box(1.5, 0.14, 0.1, dk, 0, 0.36, 1.6, g); box(1.5, 0.14, 0.1, dk, 0, 0.36, -1.6, g);
        [-0.5, 0.5].forEach(x => { box(0.34, 0.12, 0.04, glow('#fff3c4', 0.9), x, 0.66, 1.61, g); box(0.3, 0.1, 0.04, glow(COL.crit, 0.7), x, 0.68, -1.61, g); });
        [[-0.72, 1.02], [0.72, 1.02], [-0.72, -1.02], [0.72, -1.02]].forEach(p => wheel(0.3, 0.2, p[0], 0.3, p[1], g));
        box(0.16, 0.16, 0.03, dk, 0.5, 0.7, -1.615, g);                // charge flap at the rear
        return { plug: [0.5, 0.7, -1.64], top: 1.38, z: 2.5, len: 3.5 };
      }
    };
    const HUES = { rick: ['#3d7a8c', '#6f8440', '#8c5a3d'], scoot: ['#b8433f', '#3f5fb8', '#c9ccce'], cycle: ['#c2562d', '#2f6f6a', '#4a4f91'], phone: ['#3f6f9c', '#9c5a7c', '#5c8a4a'], car: ['#c9ced2', '#2e5aa8', '#a8322e'] };
    const vehs = new Map();     // session object -> its 3D vehicle

    function place(u, port) {
      let vh = vehs.get(u);
      if (!vh) {
        const g = new THREE.Group(), spec = (MAKE[u.type] || MAKE.scoot)(g, (HUES[u.type] || HUES.scoot)[parseInt(u.token.slice(-2), 10) % 3]);
        g.position.set(HW + 12, 0.04, LANE); g.rotation.y = -Math.PI / 2; sc.add(g);
        vh = { g: g, spec: spec, port: -2, cable: null, tag: new Label(2.4, g, 0, spec.top + 0.5, 0) };
        if (u.prio) add(new THREE.Mesh(new THREE.OctahedronGeometry(0.13), new THREE.MeshBasicMaterial({ color: C(COL.warn).clone() })), 0, spec.top + 0.12, 0, g);
        vehs.set(u, vh);
      }
      if (vh.port !== port) { unplug(vh); vh.port = port; }
      if (port >= 0) { vh.tx = px(port); vh.tz = vh.spec.z; vh.ry = 0; vh.order = 'xz'; }
      else { vh.tz = LANE; vh.ry = -Math.PI / 2; vh.order = 'zx'; }
      vh.tag.sp.visible = port < 0;
      if (port < 0) vh.tag.set(u.token + (u.prio ? ' ★' : ''), S.smart ? 'wait ~' + dur(u.wait) : 'wait unknown', COL.warn);
      return vh;
    }
    function unplug(vh) {
      if (!vh.cable) return;
      sc.remove(vh.cable.mesh); vh.cable.mesh.geometry.dispose(); vh.cable.flow.dispose(); vh.cable = null;
    }
    function plugIn(vh) {
      vh.g.updateMatrixWorld();
      const b = vh.g.localToWorld(new THREE.Vector3(vh.spec.plug[0], vh.spec.plug[1], vh.spec.plug[2])), x = ports[vh.port].x;
      const c = path([[x + 0.1, 1.05, 0.13], [x + 0.14, 0.75, 0.3], [(x + b.x) / 2 + 0.1, 0.4, (0.3 + b.z) / 2], [b.x, b.y, b.z]], 0.5);
      vh.cable = { mesh: tube(c, 0.03, dk, sc), flow: new Flow(c, COL.load, 4, 0.06, 2.4, sc) };
    }

    function sync() {
      const N = S.now, seen = new Set();
      S.ports.forEach((p, i) => {
        const R = ports[i], u = p.s, state = p.fault ? 'fault' : u ? u.state : 'free';
        R.state = state; R.kw = p.set;
        R.fill.scale.y = Math.max(0.001, p.set / p.max); R.fill.visible = p.set > 0.01;
        R.label.set('P' + p.id + ' ' + (p.fault ? 'FAULT' : !u ? 'free' : state === 'hold' ? 'hold' : state === 'trip' ? 'TRIP' : p.set.toFixed(2) + 'kW'), '', LAMP[state]);
        if (u) { seen.add(u); place(u, i); }
      });
      let qx = XE - 1;                                    // the lane fills from the east end, each vehicle taking its own length
      S.queue.forEach(u => { seen.add(u); const vh = place(u, -1); qx -= vh.spec.len / 2; vh.tx = qx; qx -= vh.spec.len / 2 + 0.5; });
      vehs.forEach((vh, u) => {
        if (seen.has(u) || vh.gone) return;
        unplug(vh); vh.gone = true; vh.port = -1; vh.tag.sp.visible = false;
        vh.tx = -HW - 48; vh.tz = 9.2; vh.ry = -Math.PI / 2; vh.order = 'zx';       // drive off along the road
      });

      const lit = Math.round(S.soc / 10), low = S.soc <= S.c.socFloor + 0.6 ? COL.crit : S.soc < S.c.socDerate ? COL.warn : COL.batt;
      segOn.emissive.copy(C(S.faults.bms ? COL.crit : low));
      segs.forEach((s, k) => { s.material = k % 10 < lit ? segOn : segOff; });
      panels.forEach(p => { p.material.color.copy(C(S.faults.pvString && p.userData.stringB ? '#7a3b3b' : '#ffffff')); });
      mpptLamp.material.emissive.copy(C(S.hot ? COL.crit : S.temp > S.c.hotC - 12 ? COL.serious : COL.good));

      const mode = !S.smart ? (N.tripped ? 'TRIPPED, ' + Math.ceil(N.tripLeft) + ' min' : 'bypassed') : N.limiter === 'none' ? 'full power' : 'sharing ' + N.budget.toFixed(2) + ' kW';
      pvLabel.set('PV array ' + S.c.pvKwp + ' kWp', S.faults.pvString ? 'string B open · ' + N.pv.toFixed(2) + ' kW' : N.pv.toFixed(2) + ' kW · ' + Math.round(S.cloud * 100) + '% cloud', COL.pv);
      battLabel.set('Battery ' + Math.round(S.soc) + '%', S.faults.bms ? 'offline, BMS open' : N.batt > 0.02 ? 'discharging ' + N.batt.toFixed(2) + ' kW' : N.batt < -0.02 ? 'charging ' + (-N.batt).toFixed(2) + ' kW' : 'idle', S.faults.bms ? COL.crit : low);
      const gcol = S.backup && S.faults.grid ? COL.crit : N.gridAvail > 0 ? COL.grid : COL.idle;
      gridLabel.set('Grid backup ' + S.c.gridKw + ' kW', !S.backup ? 'switched off' : S.faults.grid ? 'grid outage' : N.gridAvail > 0 ? 'supplying ' + N.grid.toFixed(2) + ' kW' : 'standby', gcol);
      gridLamp.material.emissive.copy(C(gcol));
      mpptLabel.set('MPPT + 48 V bus', Math.round(S.temp) + ' °C · limit ' + N.busLim.toFixed(1) + ' kW', S.hot ? COL.crit : COL.idle);
      ctlLabel.set('Silent Assassins', mode, !S.smart ? (N.tripped ? COL.crit : COL.warn) : N.limiter === 'none' ? COL.good : COL.load);
      const q = S.queue[0];
      kiosk.set(!S.smart && N.tripped ? ['SILENT ASSASSINS', '** TRIPPED **', 'all ports off', 'back in ' + Math.ceil(N.tripLeft) + ' min'] :
        ['SILENT ASSASSINS', 'AVAIL  ' + N.budget.toFixed(2) + ' kW', 'IN USE ' + N.load.toFixed(2) + ' kW', 'WAITING ' + S.queue.length, N.gridAvail > 0 ? 'BACKUP ' + N.grid.toFixed(2) + ' kW' : 'BACKUP standby', q ? 'NEXT ' + (S.smart ? '~' + dur(q.wait) : 'unknown') : 'PLUG IN NOW']);
    }

    function tick(dt, now, snap) {
      const N = S.now;
      // sun and sky follow the station clock
      const x = (S.t - 360) / 720, el = Math.sin(Math.PI * clamp(x, -0.5, 1.5));
      const day = smooth(-0.04, 0.3, el), dusk = smooth(-0.25, 0.02, el) * (1 - smooth(0.1, 0.45, el));
      sky.copy(NIGHT).lerp(DAY, day).lerp(DUSK, dusk * 0.7).lerp(GREY, S.cloud * 0.65 * day);
      sc.background.copy(sky); sc.fog.color.copy(sky).convertSRGBToLinear();
      const a = Math.PI * clamp(x, -0.08, 1.08);
      dir.set(-Math.cos(a), Math.max(0.04, Math.sin(a)), 0.45).normalize();
      sun.position.copy(dir).multiplyScalar(60);
      sun.intensity = 1.05 * day * (1 - 0.75 * S.cloud);
      sun.color.copy(WARM).lerp(WHITE, smooth(0.05, 0.5, el));
      hemi.intensity = 0.18 + 0.4 * day * (1 - 0.3 * S.cloud);
      sunBall.position.copy(dir).multiplyScalar(120); sunBall.visible = el > -0.03;
      lamps.forEach(l => { l.intensity = (1 - day) * 1.5; });
      cloudMat.opacity = clamp(S.cloud * 1.25, 0, 0.95) * (0.35 + 0.65 * day);
      cloudMat.color.setScalar(1 - 0.35 * S.cloud);
      clouds.forEach((g, i) => { g.visible = cloudMat.opacity > 0.03; g.position.x += dt * (0.25 + (i % 3) * 0.1); if (g.position.x > 66) g.position.x = -66; });

      pvFlow.set(dt, N.pv, 8); battFlow.set(dt, Math.abs(N.batt), 6, N.batt < 0); busFlow.set(dt, N.load, 10);
      gridFlow.set(dt, N.grid, 3); dropFlow.set(dt, N.grid, 3);
      const blink = Math.sin(now * 7) > 0, trip = !S.smart && N.tripped;
      ports.forEach(R => {
        R.flow.set(dt, R.kw, R.max);
        R.lamp.material.emissive.copy(C(trip ? COL.crit : LAMP[R.state]));
        R.lamp.material.emissiveIntensity = R.state === 'free' ? 0.45 : (trip || R.state === 'fault' || R.state === 'hold') && !blink ? 0.15 : 1.4;
      });
      beacon.material.emissive.copy(C(trip ? COL.crit : !S.smart ? COL.warn : N.limiter === 'none' ? COL.good : COL.load));
      beacon.material.emissiveIntensity = trip && !blink ? 0.1 : 1.5;

      vehs.forEach((vh, u) => {
        const p = vh.g.position, sp = 7 * dt;
        if (snap) { p.x = vh.tx; p.z = vh.tz; vh.g.rotation.y = vh.ry; }      // the view was hidden: do not replay the drive
        const mv = (ax, t) => { const d = t - p[ax]; if (Math.abs(d) < 1e-3) return true; p[ax] += Math.sign(d) * Math.min(Math.abs(d), sp); return false; };
        const there = vh.order === 'xz' ? mv('x', vh.tx) && mv('z', vh.tz) : mv('z', vh.tz) && mv('x', vh.tx);
        vh.g.rotation.y += (vh.ry - vh.g.rotation.y) * Math.min(1, dt * 5);
        p.y = p.z < 4.4 ? PAD : 0.04;
        if (vh.gone) { if (there) { sc.remove(vh.g); vehs.delete(u); } return; }
        if (vh.port >= 0 && there && !vh.cable && Math.abs(vh.g.rotation.y) < 0.02) plugIn(vh);
        if (vh.cable) vh.cable.flow.set(dt, ports[vh.port].kw, ports[vh.port].max);
      });
    }
    return { sync: sync, tick: tick };
  }

  /* =====================================================================
     Scene 2: the bench prototype (4 ports, 12 V). Units are centimetres.
     It mirrors ports 1 to 4 of the live station: 1 kW there is shown as 1 A here.
     ===================================================================== */
  function buildBench(v) {
    /* Layout, back to front, so that it reads like the schematic:
         back row     solar panel | backup input | 5 V buck | LCD
         12 V rail    one bar feeding four identical port channels that run towards the viewer
         each channel current sensor -> MOSFET -> relay -> LED load -> ground bar at the front edge
       Power runs down the left of each channel; every control wire comes in from the right, from the ESP32.
       All wires lie flat and turn at right angles, and parallel wires are nested so they do not cross. */
    const sc = v.scene, xs = [-9, -1, 7, 15], rows = [];
    const silver = M('#c3c8cb', 0.3, 0.85), black = M('#141618', 0.6), gold = M('#c9a23c', 0.35, 0.8), blueT = M('#2d6cc0', 0.5), greenT = M('#2f9a5a', 0.5);
    const W = { red: M('#c8322f', 0.55), blk: M('#17191b', 0.6), blue: M('#2f6fd0', 0.55), org: M('#e07b26', 0.55), grn: M('#2c9d57', 0.55), yel: M('#d8b22a', 0.55), wht: M('#e6e6e0', 0.55), pur: M('#7a55c7', 0.55) };
    // turn = true lays a part out along the channel (its local +x points towards the viewer)
    const part = (x, z, name, role, live, click, turn) => { const g = new THREE.Group(); g.position.set(x, 0, z); if (turn) g.rotation.y = -Math.PI / 2; g.userData.info = { name: name, role: role, live: live, click: click }; sc.add(g); v.picks.push(g); return g; };
    const run = (pts, m, r) => tube(path(pts), r || 0.12, m, sc);
    const P = i => S.ports[i] || { set: 0, s: null, fault: null, comms: true };
    const amps = i => P(i).set, duty = i => Math.round(clamp(P(i).set / S.c.portMax, 0, 1) * 100);
    const closed = i => !!P(i).s && !P(i).fault;

    sc.background = new THREE.Color(); sc.fog = new THREE.Fog(0x000000, 120, 280);
    sc.add(new THREE.HemisphereLight(0xffffff, 0x9aa0a4, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 0.95); key.position.set(-25, 70, 35); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048); Object.assign(key.shadow.camera, { left: -48, right: 48, top: 38, bottom: -38, near: 10, far: 190 }); key.shadow.camera.updateProjectionMatrix(); key.shadow.bias = -0.0008;
    sc.add(key);
    const table = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), new THREE.MeshStandardMaterial({ roughness: 1 })); table.rotation.x = -Math.PI / 2; table.position.y = -0.82; table.receiveShadow = true; sc.add(table);
    const theme = () => { const c = new THREE.Color(css('--panel-2') || '#ebebeb'); sc.background.copy(c); sc.fog.color.copy(c).convertSRGBToLinear(); table.material.color.copy(c).convertSRGBToLinear(); };
    theme();
    if (window.matchMedia) { const mq = window.matchMedia('(prefers-color-scheme: dark)'); (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(theme); }
    box(72, 0.8, 47, M('#ddd8ca', 0.85), 0.5, -0.4, 0, sc);

    /* ---- power sources, left edge ---- */
    let g = part(-25, -15.5, 'Solar panel, 12 V 20 W', 'The energy source. On the bench a lamp or the sun; its output sets the power budget.', () => 'station PV now ' + S.now.pv.toFixed(2) + ' kW');
    add(new THREE.Mesh(new THREE.BoxGeometry(12, 0.35, 8.5), new THREE.MeshStandardMaterial({ map: cellTexture(), roughness: 0.28, metalness: 0.35 })), 0, 3.2, 0, g).rotation.x = 0.6;
    bar([-5, 0, -3.2], [-5, 5.4, -3.2], 0.18, silver, g); bar([5, 0, -3.2], [5, 5.4, -3.2], 0.18, silver, g); box(11, 0.4, 0.6, silver, 0, 0.2, 3.4, g);

    g = part(-25, -3, 'Solar charge controller, 10 A', 'Charges the battery from the panel (PWM or MPPT) and protects it from overcharge and deep discharge.', () => 'battery ' + Math.round(S.soc) + '%' + (S.faults.bms ? ', BMS fault' : ''));
    box(8.5, 2.4, 5.2, M('#1d3f5e', 0.5), 0, 1.2, 0, g);
    box(3, 0.06, 1.6, glow('#9fe0b0', 0.9), -1.4, 2.43, -0.7, g);
    [COL.good, COL.warn, COL.crit].forEach((c, k) => cyl(0.18, 0.08, glow(c, k === 0 ? 1.2 : 0.15), 1.4 + k * 0.8, 2.44, -0.7, g, 10));
    box(7.6, 0.9, 1.1, M('#2a2e33', 0.6), 0, 0.45, 3.1, g);
    for (let k = 0; k < 6; k++) cyl(0.22, 0.12, silver, -3 + k * 1.2, 0.95, 3.1, g, 10);

    g = part(-24.5, 12, 'Battery, 12 V 7 Ah', 'Buffer between the sun and the loads. The controller keeps a 20% reserve and derates below 30%.', () => Math.round(S.soc) + '% charge, ' + (S.now.batt > 0.02 ? 'discharging' : S.now.batt < -0.02 ? 'charging' : 'idle'));
    box(15, 6.5, 9.4, M('#2d3238', 0.6), 0, 3.25, 0, g); box(15.1, 0.5, 9.5, M('#3b4249', 0.6), 0, 6.3, 0, g);
    const bl = new Screen(360, 120, '#12806a', '#f1f5f6', 40); bl.set(['12 V  7 Ah', 'RECHARGEABLE']);
    add(new THREE.Mesh(new THREE.PlaneGeometry(9, 3), new THREE.MeshBasicMaterial({ map: bl.tex })), 0, 3.1, 4.72, g);
    box(1.3, 0.4, 1.0, W.red, 4.5, 6.75, 3.2, g); box(0.5, 0.9, 0.12, silver, 4.5, 7.2, 3.2, g);
    box(1.3, 0.4, 1.0, W.blk, -4.5, 6.75, 3.2, g); box(0.5, 0.9, 0.12, silver, -4.5, 7.2, 3.2, g);

    // panel -> controller along the left edge; controller -> battery up its back face
    const pvRun = path([[-24.7, 0.9, -11.9], [-24.7, 0.5, -10.4], [-30.4, 0.5, -10.4], [-30.4, 0.5, 1.5], [-28, 0.5, 1.5], [-28, 0.95, 0.3]]);
    tube(pvRun, 0.2, W.red, sc);
    run([[-25.3, 0.9, -11.9], [-25.3, 0.5, -11], [-31, 0.5, -11], [-31, 0.5, 2.1], [-26.8, 0.5, 2.1], [-26.8, 0.95, 0.3]], W.blk, 0.2);
    run([[-24.4, 0.95, 0.3], [-24.4, 0.5, 3], [-20.6, 0.5, 3], [-20.6, 0.5, 7], [-20.6, 6.85, 7.12], [-20.6, 6.85, 15.2]], W.red, 0.2);
    run([[-25.6, 0.95, 0.3], [-25.6, 0.5, 3.6], [-28.4, 0.5, 3.6], [-28.4, 0.5, 7], [-28.4, 6.85, 7.12], [-28.4, 6.85, 15.2]], W.blk, 0.2);
    // battery + -> fuse -> 12 V rail; battery - -> ground bar along the front edge
    const feed = path([[-19.6, 6.85, 15.2], [-16.6, 6.85, 15.2], [-16.6, 0.5, 15.4], [-15, 0.5, 15.4], [-15, 0.5, -8.5], [-12.8, 0.95, -8.5]]);
    tube(feed, 0.22, W.red, sc);
    bar([-15, 0.5, 0.5], [-15, 0.5, 3.5], 0.5, black, part(0, 0, '10 A fuse', 'Protects the battery wiring if anything downstream shorts.', null));
    run([[-29, 6.85, 15.6], [-29, 6.85, 16.95], [-29, 0.5, 17.1], [-29, 0.5, 20.6], [-12.8, 0.7, 20.6]], W.blk, 0.22);

    g = part(3, -8.5, '12 V load rail', 'Lever-terminal strip that fans the battery supply out to the four port channels, the buck converter and the backup input.', () => 'total ' + [0, 1, 2, 3].reduce((s, i) => s + amps(i), 0).toFixed(2) + ' A');
    box(31.5, 1.0, 1.5, M('#d9dcdd', 0.6), 0, 0.5, 0, g);
    [-15.4, 1, 7].concat(xs.map(x => x - 3.3)).forEach(x => box(1.3, 0.35, 1.1, M('#e8792b', 0.5), x, 1.15, 0, g));
    g = part(3, 20.6, 'Ground bar', 'Common return for the four loads, wired back to the battery negative terminal.', null);
    box(31.5, 0.9, 1.3, M('#2a2e33', 0.6), 0, 0.45, 0, g);
    for (let k = 0; k < 10; k++) cyl(0.25, 0.12, gold, -14 + k * 3.1, 0.95, 0, g, 10);

    /* ---- back row: backup input and the 5 V supply for the electronics ---- */
    g = part(4, -14.8, 'Backup input: 12 V mains adapter + changeover relay', 'The backup feed on the bench. The ESP32 closes this relay (GPIO5) when the battery is low, so a mains adapter helps carry the load rail.', () => !S.backup ? 'switched off' : S.faults.grid ? 'no mains: backup unavailable' : S.now.gridAvail > 0 ? 'ENGAGED: station backup at ' + S.now.grid.toFixed(2) + ' kW' : 'standby', null, true);
    box(4.6, 0.16, 2.6, M('#b3272d', 0.5), 0, 0.6, 0, g); box(1.9, 1.55, 1.5, M('#1f5fbf', 0.35), 0.2, 1.45, 0.1, g);
    box(0.8, 0.9, 2.2, blueT, 1.85, 1.1, 0, g); box(0.5, 0.6, 1.2, black, -1.95, 0.98, 0, g);
    box(1.5, 1.1, 1.3, black, -3.6, 0.55, 0, g); cyl(0.28, 0.5, silver, -4.5, 0.6, 0, g, 10).rotation.z = Math.PI / 2;
    const bled = box(0.24, 0.14, 0.14, glow(COL.grid, 0.1), -1.2, 0.76, 0.8, g);
    const backRun = path([[4, 1.05, -12.6], [4, 0.95, -9.3]]);
    tube(backRun, 0.2, W.red, sc);

    g = part(13, -15, 'Buck converter, 12 V to 5 V', 'Steps the battery voltage down to power the ESP32, relays and display.', null);
    box(4.4, 0.16, 2.2, M('#1f4fa8', 0.5), 0, 0.6, 0, g); box(1.2, 0.75, 1.2, M('#3c3f43', 0.5), 0.6, 1.05, 0, g);
    cyl(0.42, 1.0, black, -1.6, 1.18, 0.3, g, 14); cyl(0.42, 1.0, black, 1.75, 1.18, -0.35, g, 14);
    box(0.6, 0.2, 0.7, black, -0.55, 0.78, -0.35, g); box(0.6, 0.45, 0.28, M('#2b62c9', 0.5), -0.5, 0.9, 0.8, g); cyl(0.1, 0.5, gold, -0.5, 0.95, 0.8, g, 8);
    run([[10, 1.05, -9.25], [10, 0.5, -10.2], [10, 0.5, -15], [10.75, 0.75, -15]], W.red, 0.16);
    // 5 V and the backup-relay control wire share one lane behind the back row and up the right edge
    run([[15.4, 0.75, -15], [16.4, 0.3, -15], [16.4, 0.3, -19.6], [31, 0.3, -19.6], [31, 0.3, -3.2], [29.1, 1.05, -3.2]], W.red);
    run([[4, 1.0, -16.9], [6.4, 0.3, -16.9], [6.4, 0.3, -20.1], [31.5, 0.3, -20.1], [31.5, 0.3, -2.4], [29.1, 1.05, -2.4]], W.pur);

    /* ---- four port channels ---- */
    xs.forEach((x, i) => {
      const n = i + 1, addr = ['0x40', '0x41', '0x44', '0x45'][i], pwm = [25, 26, 27, 14][i], rly = [32, 33, 16, 17][i], xp = x - 0.3, k = 3 - i;
      g = part(x, -2, 'INA219 current sensor, port ' + n, 'Measures the port current over I2C (' + addr + '). The controller isolates a port that draws 20% more than its setpoint.', () => P(i).comms ? 'reading ' + amps(i).toFixed(2) + ' A' : 'no reading: port held at minimum power', null, true);
      box(3.2, 0.16, 2.4, M('#5a3d91', 0.5), 0, 0.6, 0, g); box(0.9, 0.3, 0.5, black, 0, 0.83, 0.1, g); box(0.45, 0.14, 0.45, black, 0, 0.75, -0.55, g);
      box(0.7, 0.85, 1.3, blueT, -1.2, 1.1, 0.4, g); box(0.7, 0.85, 1.3, blueT, 1.2, 1.1, 0.4, g);
      box(1.9, 0.5, 0.26, black, 0, 0.93, -1.0, g); for (let j = 0; j < 6; j++) box(0.07, 0.5, 0.07, gold, -0.75 + j * 0.3, 1.4, -1.0, g);

      g = part(x, 4.5, 'IRLZ44N MOSFET, port ' + n, 'Sets the port power by PWM from GPIO' + pwm + ' (220 Ω gate resistor, 10 kΩ pull-down). The commercial unit uses a CC/CV DC-DC module here.', () => 'duty ' + duty(i) + '%', null, true);
      box(3.4, 0.16, 3.0, M('#b98a4a', 0.8), 0, 0.6, 0, g);
      box(1.7, 2.1, 0.22, M('#22262a', 0.4, 0.6), 0, 1.9, 0.62, g); for (let j = 0; j < 5; j++) box(0.12, 2.1, 0.7, M('#22262a', 0.4, 0.6), -0.7 + j * 0.35, 1.9, 1.05, g);
      box(1.0, 0.9, 0.45, black, 0, 1.4, 0.28, g); box(1.0, 0.65, 0.12, silver, 0, 2.15, 0.45, g);
      [-0.25, 0, 0.25].forEach(q => box(0.08, 0.5, 0.08, silver, q, 0.82, 0.2, g));
      [[-0.9, -0.9], [0.7, -0.9]].forEach(q => { cyl(0.14, 0.62, M('#d8c59a', 0.6), q[0], 0.84, q[1], g, 8).rotation.z = Math.PI / 2; });
      box(0.6, 0.8, 1.0, greenT, -1.35, 1.05, 0.2, g); box(0.6, 0.8, 1.0, greenT, 1.35, 1.05, 0.2, g);

      g = part(x, 11, 'Relay, port ' + n, 'Isolates the port on a fault (GPIO' + rly + '). Opens and latches on overcurrent until an operator resets it.', () => closed(i) ? 'closed: port live' : P(i).fault ? 'OPEN, latched on fault' : 'open: no user', null, true);
      box(4.6, 0.16, 2.6, M('#b3272d', 0.5), 0, 0.6, 0, g); box(1.9, 1.55, 1.5, M('#1f5fbf', 0.35), 0.2, 1.45, 0.15, g);
      box(0.8, 0.9, 2.2, blueT, 1.85, 1.1, 0, g); box(0.5, 0.6, 1.2, black, -1.95, 0.98, 0, g); box(0.6, 0.3, 0.45, black, -1.2, 0.83, -0.7, g);
      const rled = box(0.24, 0.14, 0.14, glow(COL.crit, 0.1), -1.2, 0.76, 0.75, g);

      g = part(x, 17, 'Port ' + n + ' load (12 V LED bar)', 'Stands in for a charging vehicle. Its brightness is the power the controller has granted this port.', () => { const u = P(i).s; return (u ? u.token + ' ' + S.T[u.type].name + ', ' : 'no user, ') + amps(i).toFixed(2) + ' A'; });
      box(6, 0.25, 1.3, M('#cfd4d6', 0.4, 0.5), 0, 0.3, 0, g); box(0.9, 0.9, 1.3, greenT, 3.5, 0.6, 0, g);
      const lm = new THREE.MeshStandardMaterial({ color: C('#6d6a5c').clone(), emissive: C('#ffe9a8').clone(), emissiveIntensity: 0, roughness: 0.4 });
      for (let j = 0; j < 6; j++) box(0.5, 0.18, 0.5, lm, -2.25 + j * 0.9, 0.5, 0, g);

      // power: down the left of the channel, rail -> sensor -> MOSFET -> relay -> load -> ground bar
      run([[xp, 1.05, -7.8], [xp, 0.9, -3.75]], W.red, 0.22); run([[xp, 0.9, -0.35], [xp, 0.9, 2.75]], W.red, 0.22);
      run([[xp, 0.9, 6.25], [xp, 0.9, 8.2], [x - 1, 0.9, 8.2], [x - 1, 0.9, 8.75]], W.red, 0.22);
      run([[x, 1.0, 13.3], [x, 0.9, 14.7], [x + 3.5, 0.9, 14.7], [x + 3.5, 0.9, 16.3]], W.red, 0.22);
      run([[x + 3.5, 0.8, 17.7], [x + 3.5, 0.75, 19.95]], W.blk, 0.22);
      // control: straight lanes from the ESP32; the nearest channel takes the lane closest to its parts
      const zp = 2.3 - k * 0.3, zr = 7.9 - k * 0.3;
      run([[23.9, 1.05, zp], [23.2, 0.3, zp], [x + 0.9, 0.3, zp], [x + 0.9, 0.75, 2.95]], W.blue);
      run([[23.9, 1.05, zr], [23.2, 0.3, zr], [x + 0.3, 0.3, zr], [x + 0.3, 0.3, 8.35], [x + 0.3, 1.0, 8.9]], W.org);
      run([[x + 1.8, 0.3, -4.4], [x + 1.8, 0.3, -2.4], [x + 1.15, 1.3, -2.4]], W.grn, 0.11);
      run([[x + 2.2, 0.3, -4.8], [x + 2.2, 0.3, -1.8], [x + 1.15, 1.3, -1.8]], W.yel, 0.11);

      const chain = path([[xp, 1.0, -7.8], [xp, 0.95, 8.2], [x - 1, 0.95, 8.2], [x - 1, 0.95, 9.6], [x, 1.0, 12.6], [x, 0.95, 14.7], [x + 3.5, 0.95, 14.7], [x + 3.5, 0.95, 16.3]]);
      rows.push({ led: lm, rled: rled, label: new Label(6.4, sc, x, 1.3, 23.6), flow: new Flow(chain, COL.load, 10, 0.34, 9, sc) });
    });
    // the I2C bus: one pair of wires behind the sensors, tapped at each one
    run([[23.9, 1.05, -1.6], [22.8, 0.3, -1.6], [22.8, 0.3, -4.4], [xs[0] + 1.8, 0.3, -4.4]], W.grn, 0.11);
    run([[23.9, 1.05, -2], [23.2, 0.3, -2], [23.2, 0.3, -4.8], [xs[0] + 2.2, 0.3, -4.8]], W.yel, 0.11);

    /* ---- controller, right edge ---- */
    g = part(26.5, 4, 'ESP32 DevKit V1', 'Runs the 1-second control loop: read sensors, work out the budget, share it, set PWM and relays, publish telemetry over Wi-Fi (MQTT).', () => !S.smart ? 'bypassed (unmanaged mode)' : S.now.limiter === 'none' ? 'all ports at full power' : 'sharing ' + S.now.budget.toFixed(2) + ' kW between ports');
    box(5.5, 0.9, 16.5, M('#f1efe8', 0.6), 0, 0.45, 0, g);
    [-2.35, -1.95, 1.95, 2.35].forEach((q, j) => box(0.07, 0.02, 15.5, j % 2 ? W.blue : W.red, q, 0.91, 0, g));
    box(2.8, 0.16, 5.2, M('#17191c', 0.6), 0, 1.5, 0, g);
    [-1.15, 1.15].forEach(q => { box(0.25, 0.5, 4.7, black, q, 1.17, 0, g); for (let j = 0; j < 15; j++) box(0.11, 0.06, 0.11, gold, q, 1.61, -2.1 + j * 0.3, g); });
    box(1.6, 0.3, 1.8, silver, 0, 1.73, -1.3, g); box(0.8, 0.28, 0.6, silver, 0, 1.72, 2.4, g);
    box(0.3, 0.18, 0.3, silver, -0.85, 1.67, 2.0, g); box(0.3, 0.18, 0.3, silver, 0.85, 1.67, 2.0, g);
    box(0.35, 0.16, 0.65, black, 0.5, 1.66, 0.9, g); box(0.5, 0.1, 0.5, black, -0.4, 1.63, 0.6, g);
    box(0.14, 0.08, 0.14, glow(COL.crit, 1.2), 0.75, 1.62, 0, g);
    const espLed = box(0.14, 0.08, 0.14, glow(COL.load, 0.1), -0.75, 1.62, 0, g);

    // The LCD's four I2C wires plug into a header on the board margin below the screen, not into the glass.
    g = part(25.5, -15.5, '20×4 LCD, I2C 0x27', 'The kiosk display on the bench: budget, each port’s share, queue length and waiting time. Four wires: 5 V, ground, SDA, SCL.', null);
    box(0.6, 0.6, 3.4, black, -4.6, 0.3, -0.6, g); box(0.6, 0.6, 3.4, black, 4.6, 0.3, -0.6, g);
    const lt = new THREE.Group(); lt.position.set(0, 0.6, 0.6); lt.rotation.x = -0.38; g.add(lt);
    box(9.8, 6.0, 0.16, M('#1d6b3a', 0.6), 0, 3.0, 0, lt); box(9.7, 4.0, 0.8, M('#111315', 0.5), 0, 3.0, 0.45, lt);
    box(4, 1.8, 0.5, black, -2, 3.6, -0.33, lt);
    box(1.5, 0.5, 0.36, black, -0.05, 0.5, 0.26, lt); for (let j = 0; j < 4; j++) box(0.09, 0.3, 0.09, gold, -0.5 + j * 0.3, 0.5, 0.5, lt);
    const lcd = new Screen(640, 240, '#1f48d8', '#e6eeff', 44);
    add(new THREE.Mesh(new THREE.PlaneGeometry(8.7, 3.25), new THREE.MeshBasicMaterial({ map: lcd.tex })), 0, 3.0, 0.86, lt);
    g.updateMatrixWorld(true);
    [W.red, W.blk, W.grn, W.yel].forEach((m, j) => {
      const e = lt.localToWorld(new THREE.Vector3(-0.5 + j * 0.3, 0.5, 0.56));
      run([[e.x, 1.05, -3.6], [e.x, 0.3, -4.9], [e.x, 0.3, e.z + 1.3], [e.x, e.y, e.z]], m, 0.11);
    });

    g = part(25.2, 17.5, 'Alarm LED (GPIO2)', 'Lights when the controller is sharing power because demand is above the budget.', () => S.smart && S.now.limiter !== 'none' ? 'ON: load sharing active' : 'off');
    const aled = cyl(0.26, 0.6, glow(COL.crit, 0.1), 0, 0.5, 0, g, 12);
    add(new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 8), aled.material), 0, 0.8, 0, g); cyl(0.34, 0.1, black, 0, 0.15, 0, g, 12);
    run([[25.2, 1.05, 11.6], [25.2, 0.3, 12.9], [25.2, 0.3, 17.1]], W.org, 0.11);

    g = part(28.4, 17.5, 'Queue button (GPIO13)', 'A waiting user presses this to take a token. Click it to add an e-scooter to the live queue.', () => S.queue.length + ' waiting now', () => { if (hooks.arrive) hooks.arrive('scoot'); });
    box(1.3, 0.7, 1.3, black, 0, 0.35, 0, g); const cap = cyl(0.42, 0.4, M('#d03b3b', 0.4), 0, 0.85, 0, g, 14);
    g.userData.info.click = (fn => () => { cap.userData.down = 0.25; fn(); })(g.userData.info.click);
    run([[28.4, 1.05, 11.6], [28.4, 0.3, 12.9], [28.4, 0.3, 16.8]], W.wht, 0.11);

    const pvFlow = new Flow(pvRun, COL.pv, 8, 0.34, 8, sc), feedFlow = new Flow(feed, COL.batt, 10, 0.36, 9, sc), backFlow = new Flow(backRun, COL.grid, 3, 0.34, 6, sc);

    function sync() {
      const N = S.now, f = i => { const p = S.ports[i]; return p && p.s ? p.set.toFixed(2) : p && p.fault ? 'FLT ' : '----'; };
      const q = S.queue[0];
      lcd.set(!S.smart && N.tripped ? ['** OVERLOAD TRIP **', 'ALL PORTS OFF', 'RETRY IN ' + Math.ceil(N.tripLeft) + ' MIN', 'Q:' + S.queue.length] :
        ['BUD ' + N.budget.toFixed(2) + 'kW  SOC ' + Math.round(S.soc) + '%', 'P1 ' + f(0) + '   P2 ' + f(1), 'P3 ' + f(2) + '   P4 ' + f(3), 'Q:' + S.queue.length + (N.gridAvail > 0 ? ' BKP' : '') + (q ? ' NEXT ' + (S.smart ? '~' + dur(q.wait) : '?') : ' NO WAIT')]);
      rows.forEach((r, i) => {
        r.led.emissiveIntensity = 2.2 * clamp(P(i).set / S.c.portMax, 0, 1);
        r.rled.material.emissiveIntensity = closed(i) ? 1.6 : 0.08;
        const u = P(i).s, state = P(i).fault ? 'fault' : u ? u.state : 'free';
        r.label.set('P' + (i + 1) + '  ' + amps(i).toFixed(2) + ' A', u ? duty(i) + '% PWM · ' + SL[state] : P(i).fault ? 'relay open' : 'no user', LAMP[state]);
      });
      const sharing = S.smart && N.limiter !== 'none';
      bled.material.emissiveIntensity = N.gridAvail > 0 ? 1.8 : 0.1;
      aled.material.emissiveIntensity = sharing ? 1.8 : 0.1; espLed.material.emissiveIntensity = sharing ? 1.6 : 0.1;
      if (v.refreshTip) v.refreshTip();
    }
    function tick(dt) {
      const N = S.now;
      rows.forEach((r, i) => r.flow.set(dt, P(i).set, 1.5));
      pvFlow.set(dt, N.pv, 8); backFlow.set(dt, N.grid, 3);
      feedFlow.set(dt, [0, 1, 2, 3].reduce((s, i) => s + P(i).set, 0), 5);
      cap.position.y += ((cap.userData.down > 0 ? 0.7 : 0.85) - cap.position.y) * 0.4; cap.userData.down = (cap.userData.down || 0) - dt;
    }
    return { sync: sync, tick: tick };
  }

  /* ---------- start-up and the frame loop ---------- */
  const SPEC = [
    { id: 's3', build: buildStation, pick: false, o: { fov: 38, near: 0.1, far: 600, cam: [14, 9, 30], target: [-4.5, 1.6, 1], min: 6, max: 90 } },
    { id: 'b3', build: buildBench, pick: true, o: { fov: 35, near: 1, far: 900, cam: [2, 56, 50], target: [0.5, 0, 1], min: 16, max: 150 } }
  ];
  function init() {
    SPEC.forEach(sp => {
      const host = document.getElementById(sp.id); if (!host) return;
      const msg = host.querySelector('.v3d-msg');
      let v;
      try { v = new View(host, sp.o); if (sp.pick) v.enablePicking(); v.world = sp.build(v); }
      catch (e) { if (msg) msg.textContent = 'This browser could not start WebGL, so the 3D view is off. The diagrams on this page show the same live data.'; console.error(e); return; }
      if (msg) msg.remove();
      views.push(v);
      const orbit = document.getElementById(sp.id + '-orbit'), reset = document.getElementById(sp.id + '-reset');
      if (orbit) orbit.addEventListener('click', () => { v.controls.autoRotate = !v.controls.autoRotate; orbit.setAttribute('aria-pressed', v.controls.autoRotate); });
      if (reset) reset.addEventListener('click', () => { v.controls.reset(); });
    });
    requestAnimationFrame(loop);
  }
  function loop(now) {
    requestAnimationFrame(loop);
    const gap = (now - last) / 1000, dt = Math.min(0.1, gap); last = now;
    if (!S) return;
    views.forEach(v => {
      if (!v.fit()) { v.stale = true; return; }
      if (v.dirty) { v.dirty = false; v.world.sync(); }
      v.world.tick(dt, now / 1000, v.stale || gap > 0.6);
      v.stale = false;
      v.controls.update();
      v.renderer.render(v.scene, v.camera);
    });
  }
  function fail() {
    document.querySelectorAll('.v3d-msg').forEach(m => { m.textContent = 'The 3D view needs three.js. Connect to the internet once, or put three.min.js and OrbitControls.js in a vendor folder beside this page. The diagrams on this page show the same live data.'; });
  }

  window.SS3D = {
    views: views,
    update: function (st) { S = st; views.forEach(v => { v.dirty = true; }); },
    start: function (st, h) { S = st; hooks = h || {}; if (started) return; started = true; loadLib().then(init).catch(fail); }
  };
})();
