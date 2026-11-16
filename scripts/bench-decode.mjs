// Măsoară CPU-ul decodării GTFS-RT (live, de la TPBI).
// Rulează: node scripts/bench-decode.mjs
import { decodeTripUpdates, decodeVehicles, decodeAlerts } from '../src/pb.js';

const BASE = 'https://gtfs.tpbi.ro/api/gtfs-rt/';
const get = async (n) => new Uint8Array(await (await fetch(BASE + n)).arrayBuffer());

const [tu, vp, sa] = await Promise.all([get('tripUpdates'), get('vehiclePositions'), get('serviceAlerts')]);
console.log(`dimensiuni: tripUpdates ${tu.length} B, vehiclePositions ${vp.length} B, serviceAlerts ${sa.length} B`);

function bench(name, fn, n = 50) {
  for (let i = 0; i < 5; i++) fn(); // încălzire JIT
  const t = [];
  for (let i = 0; i < n; i++) { const s = performance.now(); fn(); t.push(performance.now() - s); }
  t.sort((a, b) => a - b);
  console.log(`${name.padEnd(34)} median ${t[n >> 1].toFixed(2)} ms   max ${t[n - 1].toFixed(2)} ms`);
}

// Prima rulare, „la rece” (cum ar fi într-un isolate proaspăt)
let s = performance.now(); const full = decodeTripUpdates(tu); const cold = performance.now() - s;
console.log(`tripUpdates complet, la rece:      ${cold.toFixed(2)} ms  (${full.trips.size} curse)`);

const some = new Set([...full.trips.keys()].slice(0, 8));
bench('tripUpdates complet', () => decodeTripUpdates(tu));
bench('tripUpdates filtrat (8 curse)', () => decodeTripUpdates(tu, some));
bench('vehiclePositions complet', () => decodeVehicles(vp));
bench('serviceAlerts complet', () => decodeAlerts(sa));

const v = decodeVehicles(vp);
console.log(`verificare: ${v.vehicles.length} vehicule, ex.`, v.vehicles[0]);
const a = decodeAlerts(sa);
console.log(`verificare: ${a.alerts.length} alerte, ex.:`, (a.alerts[0].header || a.alerts[0].text || '').slice(0, 80));
const t0 = full.trips.values().next().value;
console.log('verificare cursă:', t0.tripId, t0.routeId, t0.stus.length, 'opriri, prima', t0.stus[0]);
