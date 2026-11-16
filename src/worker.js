// Ruta Acum — Worker Cloudflare.
// /api/plan      variante de rută (Transitous + OSRM), inclusiv trasee cu opriri
// /api/trips     sosiri live pentru cursele de pe rută (GTFS-RT tripUpdates, filtrat)
// /api/vehicles  vehicule STB din jur / de pe liniile rutei (GTFS-RT vehiclePositions)
// /api/alerts    alerte STB pentru liniile rutei
// /api/geocode   geocodare adresă (Nominatim, căutare structurată)
// Restul cererilor sunt servite din /public (pagina).
//
// Decodările GTFS-RT sunt separate pe cereri și filtrate, ca fiecare cerere să
// rămână sub limita de 10 ms CPU a planului gratuit (vezi scripts/bench-*.mjs).

import { decodeTripUpdates, decodeVehicles, decodeAlerts, routeMatcher } from './pb.js';
import ROUTES from './routes.json';

const RT = 'https://gtfs.tpbi.ro/api/gtfs-rt/';
const TRANSITOUS = 'https://api.transitous.org/api/v5/plan';
const OSRM = { foot: 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/', bike: 'https://routing.openstreetmap.de/routed-bike/route/v1/bike/' };
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const FEED_PREFIX = 'ro-Bucuresti-Ilfov_';

const ua = (env) => `ruta-acum/${env.APP_VERSION || '0.1'} (+${env.CONTACT_URL || 'https://github.com/'})`;

// ---------- utilitare ----------
const json = (data, status = 200, maxAge = 0) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store' },
});

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// Cache în memoria isolate-ului (rapid) + Cache API (supraviețuiește între isolate-uri).
const mem = new Map();
async function cachedFetch(env, url, ttlSec, kind = 'json', headers = {}) {
  const hit = mem.get(url);
  if (hit && Date.now() - hit.at < ttlSec * 1000) return hit.v;
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(url);
  let res = cache ? await cache.match(key) : null;
  if (!res) {
    res = await fetch(url, { headers: { 'user-agent': ua(env), ...headers } });
    if (!res.ok) throw new HttpError(502, `${new URL(url).host} a răspuns ${res.status}`);
    if (cache) {
      const copy = new Response(res.clone().body, res);
      copy.headers.set('cache-control', `public, max-age=${ttlSec}`);
      await cache.put(key, copy);
    }
  }
  const v = kind === 'bin' ? new Uint8Array(await res.arrayBuffer()) : await res.json();
  mem.set(url, { at: Date.now(), v });
  if (mem.size > 200) mem.delete(mem.keys().next().value);
  return v;
}

const stripFeed = (id) => (id ? String(id).replace(/^.*?ro-Bucuresti-Ilfov_/, '') : id);
const parsePt = (s) => {
  const [lat, lon] = String(s).split(',').map(Number);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw new HttpError(400, 'coordonate invalide: ' + s);
  return { lat, lon };
};
const ms = (iso) => (iso ? Date.parse(iso) : null);
const routeInfo = (gtfsRouteId) => ROUTES[gtfsRouteId] || null;

// ---------- Transitous ----------
const MODESETS = {
  all: {},                                                       // orice transport public
  tram: { transitModes: 'TRAM' },                                // doar tramvai
  bikeMetro: { preTransitModes: 'BIKE', transitModes: 'SUBWAY', maxPreTransitTime: '1800' }, // trotinetă → metrou
};

async function transitous(env, from, to, timeMs, set) {
  const p = new URLSearchParams({
    fromPlace: `${from.lat.toFixed(5)},${from.lon.toFixed(5)}`,
    toPlace: `${to.lat.toFixed(5)},${to.lon.toFixed(5)}`,
    // rotunjim la minut ca să folosim cache-ul
    time: new Date(Math.floor(timeMs / 60000) * 60000).toISOString(),
    numItineraries: '6',
    ...MODESETS[set],
  });
  const d = await cachedFetch(env, `${TRANSITOUS}?${p}`, 120);
  return (d.itineraries || []).map((it) => normItinerary(it));
}

function normPlace(pl) {
  return { name: pl.name === 'START' || pl.name === 'END' ? null : pl.name, lat: pl.lat, lon: pl.lon, stopId: stripFeed(pl.stopId) };
}

function normItinerary(it) {
  const legs = it.legs.map((l) => {
    const isTransit = !['WALK', 'BIKE', 'CAR', 'RENTAL'].includes(l.mode);
    const routeId = stripFeed(l.routeId);
    return {
      mode: l.mode,
      line: l.routeShortName || l.displayName || null,
      color: l.routeColor ? '#' + l.routeColor : null,
      textColor: l.routeTextColor ? '#' + l.routeTextColor : null,
      headsign: l.headsign || null,
      from: normPlace(l.from), to: normPlace(l.to),
      start: ms(l.startTime), end: ms(l.endTime),
      schedStart: ms(l.scheduledStartTime), schedEnd: ms(l.scheduledEndTime),
      rt: !!l.realTime, transit: isTransit,
      tripId: isTransit ? stripFeed(l.tripId) : null,
      routeId: isTransit ? routeId : null,
      agency: l.agencyName || null,
      dist: l.distance || null,
      geom: l.legGeometry ? { p: l.legGeometry.points, prec: l.legGeometry.precision || 6 } : null,
      stops: (l.intermediateStops || []).length,
    };
  });
  return { start: legs[0].start, end: legs.at(-1).end, legs };
}

// Trotinetă → metrou: recalculăm tronsonul pe roți cu viteza și timpul de deblocare
// ale utilizatorului. Plecarea se mută mai devreme, sosirea rămâne aceeași.
function adjustScooterLegs(it, o) {
  const legs = it.legs.map((l) => ({ ...l }));
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i];
    if (l.mode !== 'BIKE') continue;
    const rideMs = ((l.dist || 0) / (o.kmh / 3.6)) * 1000;
    l.mode = 'SCOOTER'; l.estimate = true;
    if (i === 0) l.start = l.end - rideMs;   // înainte de transport: trebuie să ajungem la aceeași oră
    else l.end = l.start + rideMs;           // după transport: plecăm la aceeași oră
    legs.splice(i, 0, { mode: 'UNLOCK', start: l.start - o.unlock * 60000, end: l.start, estimate: true, transit: false, from: l.from, to: l.from });
    i++;
  }
  return { start: legs[0].start, end: legs.at(-1).end, legs, estimate: true };
}

// ---------- OSRM (pe jos / trotinetă directă) ----------
async function osrm(env, kind, from, to) {
  const url = `${OSRM[kind]}${from.lon.toFixed(5)},${from.lat.toFixed(5)};${to.lon.toFixed(5)},${to.lat.toFixed(5)}?overview=full&geometries=polyline6`;
  const d = await cachedFetch(env, url, 3600);
  if (d.code !== 'Ok' || !d.routes?.length) throw new HttpError(502, 'OSRM: fără rută');
  return { dist: d.routes[0].distance, dur: d.routes[0].duration * 1000, geom: { p: d.routes[0].geometry, prec: 6 } };
}

function walkOption(w, ready, from, to) {
  return { start: ready, end: ready + w.dur, legs: [{ mode: 'WALK', start: ready, end: ready + w.dur, dist: w.dist, geom: w.geom, from, to, transit: false }] };
}

function scooterOption(b, ready, from, to, o) {
  const ride = (b.dist / (o.kmh / 3.6)) * 1000;
  const t1 = ready + o.unlock * 60000;
  return {
    start: ready, end: t1 + ride, estimate: true,
    legs: [
      { mode: 'UNLOCK', start: ready, end: t1, estimate: true, transit: false },
      { mode: 'SCOOTER', start: t1, end: t1 + ride, dist: b.dist, geom: b.geom, from, to, estimate: true, transit: false },
    ],
  };
}

// Alege itinerariul cu cea mai devreme sosire care pleacă după `ready`.
function pick(list, ready) {
  let best = null;
  for (const it of list || []) {
    if (it.start < ready - 30000) continue;
    if (!best || it.end < best.end || (it.end === best.end && it.start > best.start)) best = it;
  }
  return best;
}

const FAMILIES = [
  { id: 'tram', label: 'Doar tramvai', set: 'tram' },
  { id: 'pt', label: 'Tramvai / autobuz + metrou', set: 'all' },
  { id: 'scooterMetro', label: 'Trotinetă până la metrou', set: 'bikeMetro', estimate: true },
  { id: 'scooter', label: 'Trotinetă Lime', osrm: 'bike', estimate: true },
  { id: 'walk', label: 'Pe jos', osrm: 'foot' },
];

async function plan(env, pts, o) {
  const now = o.time || Date.now();
  const multi = pts.length > 2;
  const nSeg = pts.length - 1;
  const noScoot = o.noScoot || new Set();            // tronsoane „cu copilul”: fără trotinetă
  const allNoScoot = [...Array(nSeg).keys()].every((i) => noScoot.has(i));
  const fams = multi ? [...FAMILIES, { id: 'combo', label: 'Combinat (cel mai rapid pe fiecare tronson)' }] : FAMILIES;
  const ready = Object.fromEntries(fams.map((f) => [f.id, now]));
  const result = Object.fromEntries(fams.map((f) => [f.id, { segs: [], error: f.estimate && allNoScoot ? 'fără trotinetă: tronson cu copilul' : null }]));
  const errors = [];
  let calls = 0;

  for (let s = 0; s < pts.length - 1; s++) {
    const from = pts[s], to = pts[s + 1];
    const fromP = { name: null, lat: from.lat, lon: from.lon }, toP = { name: null, lat: to.lat, lon: to.lon };
    const alive = fams.filter((f) => !result[f.id].error);
    const t0 = Math.min(...alive.map((f) => ready[f.id]));
    const segNoScoot = noScoot.has(s);
    const sets = segNoScoot ? ['all', 'tram'] : ['all', 'tram', 'bikeMetro'];
    const [tr, foot, bike] = await Promise.all([
      Promise.all(sets.map((k) => { calls++; return transitous(env, from, to, t0, k).catch((e) => { errors.push(`Transitous (${k}): ${e.message}`); return null; }); })),
      osrm(env, 'foot', from, to).catch((e) => { errors.push('OSRM pe jos: ' + e.message); return null; }),
      osrm(env, 'bike', from, to).catch((e) => { errors.push('OSRM trotinetă: ' + e.message); return null; }),
    ]);
    const lists = Object.fromEntries(sets.map((k, i) => [k, tr[i]]));
    if (lists.bikeMetro) lists.bikeMetro = lists.bikeMetro.map((it) => adjustScooterLegs(it, o));

    // dacă nu găsim nimic după `ready` în lista de la t0, mai întrebăm o dată la `ready`
    const pickOrRefetch = async (set, r) => {
      if (!lists[set]) return null;
      let it = pick(lists[set], r);
      if (!it && r - t0 > 60000) {
        calls++;
        let l2 = await transitous(env, from, to, r, set).catch(() => null);
        if (l2 && set === 'bikeMetro') l2 = l2.map((x) => adjustScooterLegs(x, o));
        it = pick(l2, r);
      }
      return it;
    };

    const options = async (f, r) => {
      // pe tronsoanele cu copilul, variantele cu trotinetă folosesc cea mai rapidă variantă fără trotinetă
      if (f.estimate && segNoScoot) {
        const c = await Promise.all(FAMILIES.filter((g) => !g.estimate).map((g) => options(g, r)));
        const best = c.filter(Boolean).sort((a, b) => a.end - b.end)[0];
        return best ? { ...best, noScoot: true } : null;
      }
      if (f.osrm === 'foot') return foot ? walkOption(foot, r, fromP, toP) : null;
      if (f.osrm === 'bike') return bike ? scooterOption(bike, r, fromP, toP, o) : null;
      const it = await pickOrRefetch(f.set, r);
      // trotinetă → metrou: unde metroul nu ajută pe un tronson, rămâne trotineta directă
      if (f.set === 'bikeMetro' && bike) {
        const direct = scooterOption(bike, r, fromP, toP, o);
        if (!it || direct.end <= it.end) return { ...direct, fallback: true };
      }
      return it;
    };

    for (const f of alive) {
      const r = ready[f.id];
      let it;
      if (f.id === 'combo') {
        const cands = await Promise.all(FAMILIES.filter((g) => !(segNoScoot && g.estimate)).map((g) => options(g, r)));
        it = cands.filter(Boolean).sort((a, b) => a.end - b.end)[0] || null;
      } else it = await options(f, r);
      if (!it) { result[f.id].error = s === 0 ? 'nicio rută găsită' : `nicio rută pe tronsonul ${s + 1}`; continue; }
      result[f.id].segs.push(it);
      ready[f.id] = it.end + (s < pts.length - 2 ? o.stop * 60000 : 0);
    }
  }

  const variants = fams.map((f) => {
    const r = result[f.id];
    if (r.error || !r.segs.length) return { id: f.id, label: f.label, error: r.error || 'indisponibil' };
    const legs = r.segs.flatMap((x) => x.legs);
    const transitLegs = legs.filter((l) => l.transit);
    const walkMs = legs.filter((l) => l.mode === 'WALK').reduce((a, l) => a + (l.end - l.start), 0);
    return {
      id: f.id, label: f.label,
      estimate: r.segs.some((x) => x.estimate),
      noScootSegs: r.segs.map((x, i) => (x.noScoot ? i : -1)).filter((i) => i >= 0),
      start: r.segs[0].start, end: r.segs.at(-1).end,
      walkMin: Math.round(walkMs / 60000),
      transfers: r.segs.reduce((a, x) => a + Math.max(0, x.legs.filter((l) => l.transit).length - 1), 0),
      lines: transitLegs.map((l) => ({ line: l.line, mode: l.mode, color: l.color })),
      segs: r.segs,
    };
  });

  // aceeași rută găsită de două familii (ex. „tramvai/autobuz” = „doar tramvai”) → marcăm duplicatul
  const sig = (v) => v.segs?.map((s) => s.legs.map((l) => `${l.mode}:${l.tripId || ''}`).join('|')).join('#');
  const seen = new Map();
  const prio = ['tram', 'pt', 'scooter', 'walk', 'scooterMetro', 'combo'];
  for (const v of [...variants].sort((a, b) => prio.indexOf(a.id) - prio.indexOf(b.id))) { if (v.error) continue; const k = sig(v); if (seen.has(k)) v.sameAs = seen.get(k); else seen.set(k, v.id); }

  variants.sort((a, b) => (a.error ? 1 : 0) - (b.error ? 1 : 0) || (a.end - b.end));
  return { now, stopMin: o.stop, unlockMin: o.unlock, kmh: o.kmh, variants, errors, transitousCalls: calls };
}

// ---------- GTFS-RT ----------
async function rtFeed(env, name) {
  return cachedFetch(env, RT + name, 20, 'bin');
}

async function trips(env, q) {
  // q = "tripId~stopId,tripId~stopId"
  const pairs = q.split(',').filter(Boolean).slice(0, 40).map((x) => x.split('~'));
  const buf = await rtFeed(env, 'tripUpdates');
  const t0 = performance.now();
  const { header, trips } = decodeTripUpdates(buf, new Set(pairs.map((p) => p[0])));
  const items = {};
  for (const [tripId, stopId] of pairs) {
    const t = trips.get(tripId);
    if (!t) { items[`${tripId}~${stopId}`] = { live: false }; continue; }
    const u = t.stus.find((x) => x.stopId === stopId);
    if (!u) { items[`${tripId}~${stopId}`] = { live: true, atStop: false, ts: t.ts }; continue; }
    const dep = u.dep?.time || u.arr?.time;
    const arr = u.arr?.time || u.dep?.time;
    items[`${tripId}~${stopId}`] = { live: true, atStop: true, dep: dep ? dep * 1000 : null, arr: arr ? arr * 1000 : null, ts: t.ts, canceled: t.rel === 3 };
  }
  return { feedTs: header.timestamp * 1000, decodeMs: +(performance.now() - t0).toFixed(2), items };
}

async function vehicles(env, lat, lon, radiusM, routeIds) {
  const buf = await rtFeed(env, 'vehiclePositions');
  const t0 = performance.now();
  const dLat = radiusM / 111320, dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  const rm = routeMatcher(routeIds);
  const keep = (la, lo, rg) => (Math.abs(la - lat) < dLat && Math.abs(lo - lon) < dLon) || (routeIds.length && rm(buf, rg));
  const { header, vehicles } = decodeVehicles(buf, keep);
  const out = vehicles.slice(0, 250).map((v) => {
    const r = routeInfo(v.routeId);
    return { lat: +v.lat.toFixed(6), lon: +v.lon.toFixed(6), b: v.bearing != null ? Math.round(v.bearing) : null, line: r?.[0] || '?', type: r?.[1] ?? null, color: r?.[2] ? '#' + r[2] : null, routeId: v.routeId, tripId: v.tripId, ts: v.ts ? v.ts * 1000 : null };
  });
  return { feedTs: header.timestamp * 1000, decodeMs: +(performance.now() - t0).toFixed(2), vehicles: out };
}

async function alerts(env, routeIds) {
  const buf = await rtFeed(env, 'serviceAlerts');
  const { alerts } = decodeAlerts(buf);
  const now = Date.now() / 1000, want = new Set(routeIds);
  return {
    alerts: alerts
      .filter((a) => !a.periods.length || a.periods.some((p) => (!p.start || p.start <= now) && (!p.end || p.end >= now)))
      .filter((a) => a.routes.some((r) => want.has(r)))
      .map((a) => ({ routes: a.routes.map((r) => routeInfo(r)?.[0] || r), header: a.header, text: a.text })),
  };
}

// ---------- geocodare ----------
async function geocode(env, q) {
  // întâi căutare structurată (merge mai bine pe adrese românești), apoi text liber
  const base = { format: 'jsonv2', limit: '3', countrycodes: 'ro', 'accept-language': 'ro', viewbox: '25.90,44.60,26.35,44.30' };
  const tries = [
    new URLSearchParams({ ...base, street: q.street || '', city: q.city || 'București', country: 'România' }),
    new URLSearchParams({ ...base, q: [q.street, q.city || 'București'].filter(Boolean).join(', ') }),
  ];
  for (const p of tries) {
    const d = await cachedFetch(env, `${NOMINATIM}?${p}`, 86400, 'json', { referer: env.CONTACT_URL || '' });
    if (d.length) return { results: d.map((x) => ({ lat: +x.lat, lon: +x.lon, name: x.display_name })) };
  }
  return { results: [] };
}

// ---------- protecție ----------
// Cheia de acces e un secret al Worker-ului (wrangler secret put ACCESS_KEY), nu stă în cod.
function checkKey(req, env) {
  const want = env.ACCESS_KEY;
  if (!want) throw new HttpError(503, 'serverul nu are cheie de acces configurată');
  const got = req.headers.get('x-key') || '';
  const a = new TextEncoder().encode(got), b = new TextEncoder().encode(want);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  if (diff) throw new HttpError(401, 'cheie de acces lipsă sau greșită (o pui în ⚙ Setări)');
}

// Contor pe oră, ținut în Cache API (gratuit, fără scrieri în KV). Cache-ul e per
// centru de date, deci limita e aproximativă — o plasă de siguranță, nu o garanție.
async function rateLimit(env, name, perHour) {
  const hour = new Date().toISOString().slice(0, 13);
  const key = new Request(`https://rate.limit/${name}/${hour}`);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const memKey = `rl:${name}:${hour}`;
  let n = mem.get(memKey)?.v || 0;
  if (cache) { const r = await cache.match(key); if (r) n = Math.max(n, Number(await r.text()) || 0); }
  if (n >= perHour) throw new HttpError(429, `limită atinsă: ${perHour} calcule de rută pe oră. Încearcă după ${new Date(Date.parse(hour + ':00:00Z') + 3600e3).toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Bucharest' })}`);
  n++;
  mem.set(memKey, { at: Date.now(), v: n });
  if (cache) await cache.put(key, new Response(String(n), { headers: { 'cache-control': 'max-age=3700' } }));
}

// ---------- router ----------
const num = (v, d, min, max) => { const n = Number(v); return Number.isFinite(n) && v !== null && v !== '' ? Math.min(max, Math.max(min, n)) : d; };

async function api(req, env, url) {
  const q = url.searchParams;
  switch (url.pathname) {
    case '/api/plan': {
      const pts = (q.get('pts') || '').split(';').filter(Boolean).map(parsePt);
      if (pts.length < 2 || pts.length > 4) throw new HttpError(400, 'pts: 2–4 puncte lat,lon separate prin ;');
      await rateLimit(env, 'plan', num(env.PLAN_PER_HOUR, 30, 1, 1000));
      return json(await plan(env, pts, {
        stop: num(q.get('stop'), 5, 0, 60), unlock: num(q.get('unlock'), 6, 0, 30), kmh: num(q.get('kmh'), 15, 5, 25),
        time: q.get('t') ? num(q.get('t'), 0, 0, 1e15) : 0,
        noScoot: new Set((q.get('noscoot') || '').split(',').filter((x) => x !== '').map(Number)),
      }));
    }
    case '/api/trips': return json(await trips(env, q.get('q') || ''));
    case '/api/vehicles': {
      const p = parsePt(q.get('at') || '');
      const routes = (q.get('routes') || '').split(',').filter(Boolean).slice(0, 20);
      return json(await vehicles(env, p.lat, p.lon, num(q.get('r'), 1200, 100, 5000), routes));
    }
    case '/api/alerts': return json(await alerts(env, (q.get('routes') || '').split(',').filter(Boolean)), 200, 60);
    case '/api/geocode': return json(await geocode(env, { street: q.get('street') || q.get('q') || '', city: q.get('city') || '' }));
    case '/api/health': return json({ ok: true, version: env.APP_VERSION });
    default: throw new HttpError(404, 'necunoscut');
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        if (url.pathname !== '/api/health') checkKey(req, env);
        return await api(req, env, url);
      }
      catch (e) { return json({ error: e.message || String(e) }, e.status || 500); }
    }
    return env.ASSETS.fetch(req);
  },
};
