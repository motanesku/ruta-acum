'use strict';
// Ruta Acum — pagina. Locurile salvate stau doar în localStorage pe telefon.

const PLACES = [['acasa', 'Acasă'], ['gradinita', 'Grădiniță'], ['birou', 'Birou']];
const TRIPS = { dimineata: ['gradinita', 'birou'], seara: ['gradinita', 'acasa'] };
const TRIP_START = { dimineata: 'acasa', seara: 'birou' };   // de unde pleci de obicei
// tronsoane și dacă sunt implicit „cu copilul” (fără trotinetă: Lime e pentru un singur adult)
const SEGMENTS = [['acasa', 'gradinita', true], ['gradinita', 'birou', false], ['birou', 'gradinita', false], ['gradinita', 'acasa', true]];
const placeName = (k) => PLACES.find((x) => x[0] === k)?.[1] || k;
const LIVE_EVERY = 30e3;          // sosiri live + vehicule
const REPLAN_EVERY = 3 * 60e3;    // recalcul rută (Transitous are limită ~720/zi)
const REPLAN_MIN_GAP = 60e3;      // nu recalculăm mai des de atât nici la cerere
const KEY = 'rutaAcum.v1';
const MODE = { WALK: 'Pe jos', TRAM: 'Tramvai', BUS: 'Autobuz', TROLLEYBUS: 'Troleibuz', SUBWAY: 'Metrou', SCOOTER: 'Trotinetă', UNLOCK: 'Găsit + deblocat trotineta', RAIL: 'Tren', REGIONAL_RAIL: 'Tren' };

const $ = (s, el = document) => el.querySelector(s);
const hm = (t) => new Date(t).toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Bucharest' });
const mins = (a, b) => Math.round((b - a) / 60000);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- setări ----------
function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* stocare indisponibilă */ }
  const child = Object.fromEntries(SEGMENTS.map(([a, b, d]) => [`${a}>${b}`, d]));
  return { places: {}, stop: 5, unlock: 6, kmh: 15, usage: {}, key: '', ...s, child: { ...child, ...(s.child || {}) } };
}
function saveSettings() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { banner('Nu pot salva setările pe acest dispozitiv (stocare blocată).', 'warn'); } }
let S = loadSettings();

function countPlan(n) {
  const day = new Date().toISOString().slice(0, 10);
  if (S.usage.day !== day) S.usage = { day, plans: 0, calls: 0 };
  S.usage.plans++; S.usage.calls += n; saveSettings();
}

// ---------- stare ----------
const st = { pos: null, posErr: null, target: null, plan: null, planAt: 0, planFrom: null, live: {}, vehicles: [], busy: false, lastLive: 0 };

function banner(msg, kind = 'err') {
  const b = $('#banner');
  if (!msg) { b.hidden = true; return; }
  b.hidden = false; b.className = 'banner' + (kind === 'warn' ? ' warn' : ''); b.textContent = msg;
}

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'x-key': S.key || '' } });
  if (r.status === 401) throw new Error('cheia de acces lipsește sau e greșită. Pune-o în ⚙ Setări.');
  let d; try { d = await r.json(); } catch { throw new Error(`răspuns invalid (${r.status})`); }
  if (!r.ok) throw new Error(d.error || `eroare ${r.status}`);
  return d;
}

// ---------- GPS ----------
function startGps() {
  const el = $('#gps');
  if (!('geolocation' in navigator)) { st.posErr = 'Telefonul nu oferă GPS în browser.'; el.textContent = 'fără GPS'; el.className = 'pill bad'; return; }
  if (!window.isSecureContext) { st.posErr = 'GPS-ul cere HTTPS. Deschide pagina prin linkul https.'; el.textContent = 'fără HTTPS'; el.className = 'pill bad'; return; }
  navigator.geolocation.watchPosition((p) => {
    st.pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() };
    st.posErr = null;
    el.textContent = `GPS ±${Math.round(p.coords.accuracy)} m`; el.className = 'pill ok';
    drawMe();
    if (st.target && !st.plan && !st.busy) replan(true);
  }, (e) => {
    st.posErr = e.code === 1 ? 'Accesul la locație e refuzat. Permite locația pentru această pagină în setările browserului.'
      : e.code === 3 ? 'GPS-ul nu a răspuns la timp.' : 'Nu pot afla poziția.';
    el.textContent = 'GPS indisponibil'; el.className = 'pill bad';
    if (st.target && $('#fromSel').value === 'gps') banner(st.posErr);
  }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 });
}

function startPoint() {
  const v = $('#fromSel').value;
  if (v === 'gps') {
    if (!st.pos) throw new Error(st.posErr || 'Aștept poziția GPS…');
    // ca să știm dacă tronsonul e „cu copilul”, ghicim locul de plecare:
    // locul salvat cel mai apropiat (sub 300 m), altfel începutul obișnuit al traseului
    let key = 'gps', best = 300;
    for (const [k] of PLACES) { const p = S.places[k]; if (p?.lat) { const d = dist(st.pos, p); if (d < best) { best = d; key = k; } } }
    if (key === 'gps' && TRIP_START[st.target]) key = TRIP_START[st.target];
    return { lat: st.pos.lat, lon: st.pos.lon, key };
  }
  const p = S.places[v];
  if (!p?.lat) throw new Error(`Locul „${PLACES.find((x) => x[0] === v)[1]}” nu e setat. Deschide ⚙ Setări.`);
  return { lat: p.lat, lon: p.lon, key: v };
}

const dist = (a, b) => { const R = 6371e3, r = Math.PI / 180, x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r; return Math.hypot(x, y) * R; };

function buildPoints() {
  const from = startPoint();
  const keys = TRIPS[st.target] || [st.target];
  const pts = [from];
  for (const k of keys) {
    const p = S.places[k];
    if (!p?.lat) throw new Error(`Locul „${PLACES.find((x) => x[0] === k)[1]}” nu e setat. Deschide ⚙ Setări.`);
    // dacă ești deja la o oprire (ex. la grădiniță), o sărim
    if (dist(pts.at(-1), p) < 200) continue;
    pts.push({ lat: p.lat, lon: p.lon, key: k });
  }
  if (pts.length < 2) throw new Error('Ești deja la destinație.');
  return pts;
}

// ---------- plan ----------
async function replan(force = false) {
  if (!st.target || st.busy) return;
  if (!force && Date.now() - st.planAt < REPLAN_MIN_GAP) return refreshLive();
  let pts;
  try { pts = buildPoints(); } catch (e) { banner(e.message, 'warn'); return; }
  st.busy = true; $('#refresh').classList.add('spin');
  if (!st.plan) $('#results').innerHTML = '<p class="hint">Caut variante…</p>';
  try {
    const noscoot = pts.slice(1).map((p, i) => (S.child[`${pts[i].key}>${p.key}`] ? i : -1)).filter((i) => i >= 0);
    const q = new URLSearchParams({ pts: pts.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(';'), stop: S.stop, unlock: S.unlock, kmh: S.kmh, noscoot: noscoot.join(',') });
    const d = await getJSON('/api/plan?' + q);
    countPlan(d.transitousCalls || 0);
    st.plan = d; st.planAt = Date.now(); st.planFrom = pts[0]; st.pts = pts;
    banner(d.errors?.length ? 'Unele surse nu au răspuns: ' + d.errors.join('; ') : '', 'warn');
    render(); drawRoute(true);
    await refreshLive(true);
  } catch (e) {
    banner('Nu pot calcula ruta: ' + e.message + (st.plan ? ' (afișez ultimul rezultat)' : ''));
    if (!st.plan) $('#results').innerHTML = '<p class="hint">Fără rezultat. Încearcă din nou cu ⟳.</p>';
  } finally { st.busy = false; $('#refresh').classList.remove('spin'); }
}

function transitLegs(v) { return (v.segs || []).flatMap((s) => s.legs.filter((l) => l.transit)); }
const liveKey = (l) => `${l.tripId}~${l.from.stopId}`;

// ---------- live ----------
async function refreshLive(skipReplanCheck = false) {
  if (!st.plan) return;
  const winner = st.plan.variants.find((v) => !v.error);
  const legs = st.plan.variants.flatMap(transitLegs).filter((l) => l.tripId && l.from.stopId);
  const q = [...new Set(legs.map(liveKey))].join(',');
  const at = st.pos || st.planFrom;
  const routes = [...new Set(transitLegs(winner || {}).map((l) => l.routeId).filter(Boolean))].join(',');
  const [tr, vh] = await Promise.allSettled([
    q ? getJSON('/api/trips?q=' + encodeURIComponent(q)) : Promise.resolve({ items: {} }),
    getJSON(`/api/vehicles?at=${at.lat.toFixed(5)},${at.lon.toFixed(5)}&r=1200&routes=${routes}`),
  ]);
  const errs = [];
  if (tr.status === 'fulfilled') { st.live = tr.value.items; st.liveFeedTs = tr.value.feedTs; } else errs.push('sosiri live: ' + tr.reason.message);
  if (vh.status === 'fulfilled') st.vehicles = vh.value.vehicles; else errs.push('vehicule: ' + vh.reason.message);
  if (errs.length) banner('Feed STB indisponibil (' + errs.join('; ') + '). Afișez orele după orar.', 'warn');
  st.lastLive = Date.now();
  render(); drawVehicles();
  // dacă nu mai prinzi câștigătoarea, recalculăm
  if (!skipReplanCheck && winner && leaveBy(winner) < Date.now() - 60e3) replan();
}

// ora reală de plecare de la prima stație, dacă avem date live
function liveDep(l) {
  const it = st.live[liveKey(l)];
  if (it?.atStop && it.dep) return { t: it.dep, src: 'live', canceled: it.canceled };
  if (l.rt) return { t: l.start, src: 'live' };
  return { t: l.start, src: 'orar' };
}

function leaveBy(v) {
  const first = v.segs[0].legs;
  const i = first.findIndex((l) => l.transit);
  if (i < 0) return v.start;
  // timpul de dinainte de stație rămâne același; plecarea se mută după ora live
  return v.start + (liveDep(first[i]).t - first[i].start);
}

// ---------- afișare ----------
function limeLink() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'intent://#Intent;scheme=lime;package=com.limebike;end';
  if (/iPhone|iPad/i.test(ua)) return 'lime://';
  return 'https://www.li.me/';
}

function legHtml(l, segIdx, showSeg, v) {
  let h = '';
  if (showSeg) {
    const a = st.pts[segIdx], b = st.pts[segIdx + 1];
    const names = `${a.key === 'gps' ? 'Poziția ta' : placeName(a.key)} → ${placeName(b.key)}`;
    const child = v.noScootSegs?.includes(segIdx) ? ' · cu copilul, fără trotinetă' : '';
    h += `<li class="seg">${names}${segIdx ? ` (după oprirea de ${st.plan.stopMin} min)` : ''}${child}</li>`;
  }
  const dur = mins(l.start, l.end);
  if (l.transit) {
    const d = liveDep(l);
    const inMin = mins(Date.now(), d.t);
    const delay = Math.round((d.t - (l.schedStart || l.start)) / 60000);
    const tag = d.src === 'live' ? `<span class="tag live">LIVE${delay ? (delay > 0 ? ` +${delay}` : ` ${delay}`) + ' min' : ''}</span>` : '<span class="tag sched">după orar</span>';
    const come = d.canceled ? '<b>anulată</b>' : inMin <= 0 ? 'acum' : `vine în ${inMin} min`;
    h += `<li><span class="line" style="background:${esc(l.color || '#666')};color:${esc(l.textColor || '#fff')}">${esc(l.line)}</span>
      <span>${esc(MODE[l.mode] || l.mode)} spre ${esc(l.headsign)}<br><span class="muted">${esc(l.from.name)} → ${esc(l.to.name)} · ${l.stops + 1} stații · ${dur} min</span><br>${tag} ${come}</span>
      <span class="when">${hm(d.t)}</span></li>`;
  } else {
    const km = l.dist ? ` · ${(l.dist / 1000).toFixed(1)} km` : '';
    const to = l.to?.name ? ` până la ${esc(l.to.name)}` : '';
    if (dur < 1 && l.mode === 'WALK') return h;
    h += `<li><span>${esc(MODE[l.mode] || l.mode)}${to}<span class="muted"> · ${dur} min${km}</span>${l.estimate ? ' <span class="tag est">estimare</span>' : ''}</span><span class="when">${hm(l.start)}</span></li>`;
  }
  return h;
}

function cardHtml(v, i) {
  if (v.error) return `<div class="card err"><div class="head"><span class="title">${esc(v.label)}</span></div><div class="sub">${esc(v.error)}</div></div>`;
  const lb = leaveBy(v), now = Date.now();
  const leaveIn = mins(now, lb);
  const leave = leaveIn < -1 ? `<span class="leave late">plecarea a trecut</span>` : leaveIn <= 0 ? '<span class="leave">pleacă acum</span>' : `<span class="leave">pleacă la ${hm(lb)} (în ${leaveIn} min)</span>`;
  const firstT = transitLegs(v)[0];
  const lines = transitLegs(v).map((l) => `<span class="line" style="background:${esc(l.color || '#666')};color:${esc(l.textColor || '#fff')}">${esc(l.line)}</span>`).join(' ');
  const multi = v.segs.length > 1;
  const legs = v.segs.map((s, si) => s.legs.map((l, li) => legHtml(l, si, multi && li === 0, v)).join('')).join('');
  const est = v.estimate ? `<div class="est-note">Trotineta e o estimare (${st.plan.kmh} km/h + ${st.plan.unlockMin} min găsit/deblocat): verifică în aplicația Lime. <a href="${limeLink()}">Deschide Lime</a></div>` : '';
  const dup = v.sameAs ? `<div class="sub">Aceeași rută ca „${esc(st.plan.variants.find((x) => x.id === v.sameAs)?.label)}”.</div>` : '';
  let liveLine = '';
  if (firstT) { const d = liveDep(firstT); liveLine = `<span>${esc(firstT.line)}: ${d.src === 'live' ? 'live' : 'după orar'}</span>`; }
  return `<div class="card ${i === 0 ? 'win' : ''} ${v.sameAs ? 'dup' : ''}">
    <div class="head"><span class="title">${i === 0 ? '<span class="badge">CEL MAI RAPID</span>' : ''}${esc(v.label)}</span><span class="arr">${hm(v.end)}</span></div>
    <div class="sub">${leave}<span>${mins(lb, v.end)} min total</span><span>pe jos ${v.walkMin} min</span><span>${v.transfers ? v.transfers + ' schimbări' : 'fără schimbări'}</span>${liveLine}</div>
    ${lines ? `<div style="margin-top:6px">${lines}</div>` : ''}
    ${dup}
    ${i === 0 ? `<ul class="legs">${legs}</ul>` : `<details class="more"><summary>detalii</summary><ul class="legs">${legs}</ul></details>`}
    ${est}
  </div>`;
}

function render() {
  if (!st.plan) return;
  const ok = st.plan.variants.filter((v) => !v.error).sort((a, b) => a.end - b.end);
  const bad = st.plan.variants.filter((v) => v.error);
  // duplicatele merg la final, ca să nu ocupe loc sus
  const list = [...ok.filter((v) => !v.sameAs), ...ok.filter((v) => v.sameAs), ...bad];
  $('#results').innerHTML = list.map(cardHtml).join('');
  const age = st.liveFeedTs ? Math.round((Date.now() - st.liveFeedTs) / 1000) : null;
  $('#updated').textContent = `rută ${hm(st.planAt)}` + (st.lastLive ? ` · live ${hm(st.lastLive)}${age != null && age > 120 ? ` (feed vechi ${Math.round(age / 60)} min)` : ''}` : '');
}

// ---------- hartă ----------
const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([44.4361, 26.1027], 12);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
const layers = { route: L.layerGroup().addTo(map), veh: L.layerGroup().addTo(map), me: L.layerGroup().addTo(map) };

function decodePoly(str, prec = 6) {
  const f = 10 ** prec, out = []; let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let r = 0, s = 0, b;
      do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << s; s += 5; } while (b >= 0x20);
      const d = r & 1 ? ~(r >> 1) : r >> 1;
      if (k === 0) lat += d; else lon += d;
    }
    out.push([lat / f, lon / f]);
  }
  return out;
}

function drawMe() {
  layers.me.clearLayers();
  if (st.pos) L.marker([st.pos.lat, st.pos.lon], { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [16, 16] }), zIndexOffset: 1000 }).addTo(layers.me);
}

function drawRoute(fit) {
  layers.route.clearLayers();
  const v = st.plan?.variants.find((x) => !x.error);
  if (!v) return;
  const all = [];
  for (const s of v.segs) for (const l of s.legs) {
    if (!l.geom) continue;
    const pts = decodePoly(l.geom.p, l.geom.prec); all.push(...pts);
    const style = l.transit ? { color: l.color || '#0f5c55', weight: 6, opacity: .9 }
      : l.mode === 'SCOOTER' ? { color: '#2bb24c', weight: 5, dashArray: '2 8', opacity: .95 }
        : { color: '#555', weight: 4, dashArray: '4 6', opacity: .8 };
    L.polyline(pts, style).addTo(layers.route);
    if (l.transit) for (const p of [l.from, l.to]) L.circleMarker([p.lat, p.lon], { radius: 6, color: '#fff', weight: 2, fillColor: l.color || '#0f5c55', fillOpacity: 1 }).bindTooltip(`${esc(p.name)}`).addTo(layers.route);
  }
  for (const p of st.pts.slice(1)) L.circleMarker([p.lat, p.lon], { radius: 8, color: '#fff', weight: 3, fillColor: '#d33', fillOpacity: 1 }).addTo(layers.route);
  if (fit && all.length) map.fitBounds(L.latLngBounds(all).pad(0.1));
}

function drawVehicles() {
  layers.veh.clearLayers();
  const v = st.plan?.variants.find((x) => !x.error);
  const mine = new Set(transitLegs(v || {}).map((l) => l.tripId));
  for (const x of st.vehicles) {
    const html = `<div class="veh ${mine.has(x.tripId) ? 'mine' : ''}" style="background:${esc(x.color || '#555')}">${esc(x.line)}</div>`;
    const age = x.ts ? Math.round((Date.now() - x.ts) / 1000) : null;
    L.marker([x.lat, x.lon], { icon: L.divIcon({ className: '', html, iconSize: [30, 18], iconAnchor: [15, 9] }), zIndexOffset: mine.has(x.tripId) ? 500 : 0 })
      .bindTooltip(`${esc(x.line)}${age != null ? ` · poziție de acum ${age} s` : ''}${mine.has(x.tripId) ? ' · cursa ta' : ''}`).addTo(layers.veh);
  }
}

// ---------- setări (UI) ----------
function renderPlaces() {
  const box = $('#places'); box.innerHTML = '';
  for (const [k, name] of PLACES) {
    const el = $('#placeTpl').content.firstElementChild.cloneNode(true);
    el.dataset.key = k;
    $('legend', el).textContent = name;
    const p = S.places[k] || {};
    $('.addr', el).value = p.addr || '';
    const showCoords = () => {
      const c = $('.coords', el), q = S._draft[k];
      c.textContent = q?.lat ? `✓ salvat: ${q.label || 'poziție'}` : 'nesetat';
      c.className = 'coords small ' + (q?.lat ? 'ok' : 'muted');
    };
    showCoords();
    $('.find', el).onclick = async () => {
      const addr = $('.addr', el).value.trim();
      if (!addr) return;
      const ch = $('.choices', el); ch.textContent = 'caut…';
      try {
        const d = await getJSON('/api/geocode?' + new URLSearchParams({ street: addr, city: 'București' }));
        ch.innerHTML = '';
        if (!d.results.length) { ch.textContent = 'Nu am găsit. Scrie „număr strada”, ex. „12 Strada Exemplu”.'; return; }
        for (const r of d.results) {
          const b = document.createElement('button'); b.type = 'button'; b.textContent = r.name;
          b.onclick = () => { S._draft[k] = { addr, lat: r.lat, lon: r.lon, label: r.name.split(',').slice(0, 3).join(',') }; ch.innerHTML = ''; showCoords(); };
          ch.appendChild(b);
        }
      } catch (e) { ch.textContent = 'Eroare: ' + e.message; }
    };
    $('.here', el).onclick = () => {
      if (!st.pos) { $('.choices', el).textContent = st.posErr || 'Aștept GPS-ul…'; return; }
      S._draft[k] = { addr: $('.addr', el).value.trim(), lat: st.pos.lat, lon: st.pos.lon, label: `poziția GPS (±${Math.round(st.pos.acc)} m)` };
      showCoords();
    };
    box.appendChild(el);
  }
}

function openSettings() {
  S._draft = JSON.parse(JSON.stringify(S.places));
  renderPlaces();
  const f = $('#settingsForm');
  f.stop.value = S.stop; f.unlock.value = S.unlock; f.kmh.value = S.kmh; f.key.value = S.key || '';
  $('#segs').innerHTML = SEGMENTS.map(([a, b]) => `<label class="row">${placeName(a)} → ${placeName(b)} <span><input type="checkbox" data-seg="${a}>${b}" ${S.child[`${a}>${b}`] ? 'checked' : ''}> cu copilul</span></label>`).join('');
  const u = S.usage.day === new Date().toISOString().slice(0, 10) ? S.usage : { plans: 0, calls: 0 };
  $('#usage').textContent = `Azi: ${u.plans} calcule de rută, ${u.calls} cereri Transitous de pe acest telefon (limita serviciului: ~720/zi pentru toți utilizatorii aplicației).`;
  $('#settings').showModal();
}

$('#settings').addEventListener('close', () => {
  const dlg = $('#settings');
  if (dlg.returnValue === 'save') {
    const f = $('#settingsForm');
    for (const el of document.querySelectorAll('.place')) {
      const k = el.dataset.key, d = S._draft[k];
      if (d) d.addr = $('.addr', el).value.trim();
    }
    S.places = S._draft;
    S.stop = +f.stop.value || 0; S.unlock = +f.unlock.value || 0; S.kmh = +f.kmh.value || 15;
    S.key = f.key.value.trim();
    document.querySelectorAll('[data-seg]').forEach((c) => { S.child[c.dataset.seg] = c.checked; });
    delete S._draft; saveSettings();
    if (st.target) { st.plan = null; replan(true); }
  } else delete S._draft;
});

// ---------- evenimente ----------
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-go]').forEach((x) => x.classList.toggle('active', x === b));
  st.target = b.dataset.go; st.plan = null; banner('');
  replan(true);
}));
$('#refresh').onclick = () => (Date.now() - st.planAt > REPLAN_MIN_GAP ? replan(true) : refreshLive());
$('#openSettings').onclick = openSettings;
$('#fromSel').onchange = () => { if (st.target) { st.plan = null; replan(true); } };

setInterval(() => {
  if (document.hidden || !st.plan || st.busy) return;
  if (Date.now() - st.planAt >= REPLAN_EVERY) replan(true);
  else if (Date.now() - st.lastLive >= LIVE_EVERY - 1000) refreshLive();
}, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && st.plan) (Date.now() - st.planAt >= REPLAN_EVERY ? replan(true) : refreshLive()); });

startGps();
if (!S.key || !PLACES.some(([k]) => S.places[k]?.lat)) { banner('Prima folosire: pune cheia de acces și setează Acasă, Grădiniță și Birou din ⚙.', 'warn'); }
