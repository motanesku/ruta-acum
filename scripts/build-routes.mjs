// Generează src/routes.json (route_id → [nume scurt, tip, culoare]) din GTFS-ul TPBI.
// Rulează: node scripts/build-routes.mjs  (descarcă arhiva, ~9 MB)
// Liniile se schimbă rar; rulează din nou după actualizări mari ale GTFS-ului.
import { writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const URL_GTFS = 'https://gtfs.tpbi.ro/regional/BUCHAREST-REGION.zip';
const zip = Buffer.from(await (await fetch(URL_GTFS)).arrayBuffer());

// Citește un fișier din zip folosind directorul central (suficient pentru acest feed).
function readEntry(name) {
  let eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(p + 10), csize = zip.readUInt32LE(p + 20);
    const nlen = zip.readUInt16LE(p + 28), elen = zip.readUInt16LE(p + 30), clen = zip.readUInt16LE(p + 32);
    const off = zip.readUInt32LE(p + 42);
    const n = zip.toString('utf8', p + 46, p + 46 + nlen);
    if (n === name) {
      const ln = zip.readUInt16LE(off + 26), le = zip.readUInt16LE(off + 28);
      const data = zip.subarray(off + 30 + ln + le, off + 30 + ln + le + csize);
      return (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    }
    p += 46 + nlen + elen + clen;
  }
  throw new Error('lipsește ' + name);
}

function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [h, ...rest] = rows.filter((r) => r.length > 1);
  h[0] = h[0].replace(/^﻿/, '');
  return rest.map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])));
}

const routes = parseCsv(readEntry('routes.txt'));
const out = {};
for (const r of routes) out[r.route_id] = [r.route_short_name, Number(r.route_type), r.route_color || ''];
writeFileSync(new URL('../src/routes.json', import.meta.url), JSON.stringify(out));
console.log(`src/routes.json: ${routes.length} linii`);
