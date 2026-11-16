// Decodare filtrată la rece (proces nou, fără JIT încălzit) — cazul cel mai rău pe Worker.
import { decodeTripUpdates, decodeVehicles, routeMatcher } from '../src/pb.js';
const g = async (n) => new Uint8Array(await (await fetch('https://gtfs.tpbi.ro/api/gtfs-rt/' + n)).arrayBuffer());
const [tu, vp] = await Promise.all([g('tripUpdates'), g('vehiclePositions')]);
const want = new Set(['TRIP_LV_814_1_51', 'x', 'y']);
// zonă ~1,5 km în jurul unui punct public (Piața Iancului) + liniile 5 și M1
const lat0 = 44.439, lon0 = 26.152, dLat = 0.0135, dLon = 0.019;
const rm = routeMatcher(['814', '968']);
const keep = (lat, lon, rg) => (Math.abs(lat - lat0) < dLat && Math.abs(lon - lon0) < dLon) || rm(vp, rg);
let s = performance.now(); const t = decodeTripUpdates(tu, want); const a = performance.now() - s;
s = performance.now(); const v = decodeVehicles(vp, keep); const b = performance.now() - s;
console.log(`la rece: tripUpdates filtrat ${a.toFixed(1)} ms (${t.trips.size}), vehicule ${b.toFixed(1)} ms (${v.vehicles.length}), total ${(a + b).toFixed(1)} ms`);
