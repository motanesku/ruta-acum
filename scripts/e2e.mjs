// Test end-to-end în terminal: cere variantele de rută de la Worker (local sau publicat)
// și verifică datele live pentru cursele găsite.
//
//   node scripts/e2e.mjs                    → punctele publice de test (mai jos)
//   node scripts/e2e.mjs --local acasa,birou → punctele din local/places.json (nepublicat)
//   node scripts/e2e.mjs --local acasa,gradinita,birou --stop 5
//   opțiuni: --base http://127.0.0.1:8787
// Cheia de acces: variabila RUTA_KEY sau fișierul local/access-key.txt (nepublicat).
import { readFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]] : a), []));
const BASE = args.base || 'http://127.0.0.1:8787';
let KEY = process.env.RUTA_KEY || '';
try { KEY ||= readFileSync(new URL('../local/access-key.txt', import.meta.url), 'utf8').trim(); } catch { /* fără cheie */ }
const H = { headers: { 'x-key': KEY } };

// Repere publice, folosite când nu se dau puncte locale.
const PUBLIC = {
  obor: { lat: 44.4495, lon: 26.1262 },
  iancului: { lat: 44.4396, lon: 26.1515 },
  victoriei: { lat: 44.4525, lon: 26.0857 },
};

let names, places;
if (args.local) {
  places = JSON.parse(readFileSync(new URL('../local/places.json', import.meta.url), 'utf8'));
  names = String(args.local).split(',');
} else { places = PUBLIC; names = ['iancului', 'obor', 'victoriei']; }
const pts = names.map((n) => { if (!places[n]) throw new Error('loc necunoscut: ' + n); return `${places[n].lat},${places[n].lon}`; });

const hm = (t) => new Date(t).toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Bucharest' });
const MODE = { WALK: 'pe jos', TRAM: 'Tramvai', BUS: 'Autobuz', TROLLEYBUS: 'Troleibuz', SUBWAY: 'Metrou' };

const q = new URLSearchParams({ pts: pts.join(';'), stop: args.stop || 5 });
const t0 = Date.now();
const res = await fetch(`${BASE}/api/plan?${q}`, H);
const d = await res.json();
if (!res.ok) { console.error('EROARE', res.status, d); process.exit(1); }
console.log(`Traseu: ${names.join(' → ')}  |  acum ${hm(d.now)}  |  oprire ${d.stopMin} min  |  ${d.transitousCalls} cereri Transitous, ${Date.now() - t0} ms\n`);
if (d.errors.length) console.log('Avertismente:', d.errors, '\n');

// live pentru prima plecare cu transport din fiecare variantă
const firstTransit = (v) => v.segs?.flatMap((s) => s.legs).find((l) => l.transit);
const legsAll = d.variants.flatMap((v) => v.segs?.flatMap((s) => s.legs.filter((l) => l.transit)) || []);
const tq = [...new Set(legsAll.filter((l) => l.tripId && l.from.stopId).map((l) => `${l.tripId}~${l.from.stopId}`))].join(',');
const live = tq ? await (await fetch(`${BASE}/api/trips?q=${encodeURIComponent(tq)}`, H)).json() : { items: {} };

d.variants.forEach((v, i) => {
  if (v.error) { console.log(`   ${v.label}: ${v.error}`); return; }
  const dur = Math.round((v.end - v.start) / 60000);
  const tag = v.sameAs ? `(identic cu ${v.sameAs})` : '';
  console.log(`${i === 0 ? '★' : ' '} ${String(i + 1)}. ${v.label.padEnd(28)} pleci ${hm(v.start)} → ajungi ${hm(v.end)}  ${String(dur).padStart(3)} min | pe jos ${v.walkMin} min | schimbări ${v.transfers} ${tag}`);
  v.segs.forEach((s, si) => {
    if (v.segs.length > 1) console.log(`      — tronson ${si + 1}: ${names[si]} → ${names[si + 1]} —`);
    for (const l of s.legs) {
      const min = Math.round((l.end - l.start) / 60000);
      let info = '';
      if (l.transit) {
        const it = live.items[`${l.tripId}~${l.from.stopId}`];
        const src = it?.atStop ? `LIVE ${hm(it.dep)}` : l.rt ? 'live (Transitous)' : 'după orar';
        const inMin = Math.round(((it?.atStop ? it.dep : l.start) - Date.now()) / 60000);
        info = ` ${l.line} spre ${l.headsign}  ${l.from.name} ${hm(l.start)} → ${l.to.name} ${hm(l.end)}  [${src}, vine în ${inMin} min]`;
      } else if (l.dist) info = ` ${(l.dist / 1000).toFixed(1)} km${l.to?.name ? ' → ' + l.to.name : ''}`;
      console.log(`      ${MODE[l.mode] || l.mode}${info} (${min} min)`);
    }
  });
});
console.log(`\nLive tripUpdates: decodare ${live.decodeMs ?? '-'} ms, feed vechi de ${live.feedTs ? Math.round((Date.now() - live.feedTs) / 1000) : '?'} s`);
const first = firstTransit(d.variants.find((v) => !v.error && firstTransit(v)) || {});
if (first) {
  const vq = new URLSearchParams({ at: pts[0], routes: first.routeId, r: 1200 });
  const vv = await (await fetch(`${BASE}/api/vehicles?${vq}`, H)).json();
  const onLine = vv.vehicles.filter((x) => x.routeId === first.routeId);
  console.log(`Vehicule: ${vv.vehicles.length} în zonă / pe linia ${first.line} (${onLine.length} pe linie), decodare ${vv.decodeMs} ms`);
  const al = await (await fetch(`${BASE}/api/alerts?routes=${[...new Set(legsAll.map((l) => l.routeId))].join(',')}`, H)).json();
  console.log(`Alerte pe liniile rutelor: ${al.alerts.length}${al.alerts.length ? ' — ' + al.alerts.map((a) => `[${a.routes.join(',')}] ${a.header || ''}`).join(' | ') : ''}`);
}
