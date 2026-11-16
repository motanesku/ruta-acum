// Decodor protobuf minimal pentru GTFS-Realtime (doar câmpurile folosite).
// Fără dependențe; sare peste tot ce nu ne trebuie, ca să consume puțin CPU.

const td = new TextDecoder();

class R {
  constructor(buf, start = 0, end = buf.length) {
    this.b = buf; this.p = start; this.end = end;
  }
  more() { return this.p < this.end; }
  // întoarce [valoare ca număr (bun pt. uint până la 2^53), low32]
  varint() {
    const b = this.b; let v = 0, lo = 0, s = 0, x;
    do {
      x = b[this.p++];
      if (s < 32) lo |= (x & 0x7f) << s;
      v += (x & 0x7f) * 2 ** s;
      s += 7;
    } while (x & 0x80);
    this.lo = lo;
    return v;
  }
  int32() { this.varint(); return this.lo | 0; }
  key() { const k = this.varint(); this.wt = k & 7; return k >>> 3; }
  bytesEnd() { const n = this.varint(); const s = this.p; this.p += n; return [s, this.p]; }
  str() { const [s, e] = this.bytesEnd(); return td.decode(this.b.subarray(s, e)); }
  sub() { const [s, e] = this.bytesEnd(); return new R(this.b, s, e); }
  f32() { const v = new DataView(this.b.buffer, this.b.byteOffset + this.p, 4).getFloat32(0, true); this.p += 4; return v; }
  skip() {
    switch (this.wt) {
      case 0: this.varint(); break;
      case 1: this.p += 8; break;
      case 2: this.bytesEnd(); break;
      case 5: this.p += 4; break;
      default: throw new Error('wire type ' + this.wt);
    }
  }
}

function header(r) {
  const h = {};
  while (r.more()) { const f = r.key(); if (f === 3) h.timestamp = r.varint(); else r.skip(); }
  return h;
}

function tripDesc(r) {
  const t = {};
  while (r.more()) {
    const f = r.key();
    if (f === 1) t.tripId = r.str();
    else if (f === 3) t.startDate = r.str();
    else if (f === 4) t.rel = r.varint();
    else if (f === 5) t.routeId = r.str();
    else r.skip();
  }
  return t;
}

function stEvent(r) {
  const e = {};
  while (r.more()) {
    const f = r.key();
    if (f === 1) e.delay = r.int32();
    else if (f === 2) e.time = r.varint();
    else r.skip();
  }
  return e;
}

function stu(r) {
  const u = {};
  while (r.more()) {
    const f = r.key();
    if (f === 1) u.seq = r.varint();
    else if (f === 2) u.arr = stEvent(r.sub());
    else if (f === 3) u.dep = stEvent(r.sub());
    else if (f === 4) u.stopId = r.str();
    else if (f === 5) u.rel = r.varint();
    else r.skip();
  }
  return u;
}

function vehDesc(r) {
  const v = {};
  while (r.more()) {
    const f = r.key();
    if (f === 1) v.id = r.str(); else if (f === 2) v.label = r.str(); else r.skip();
  }
  return v;
}

// Iterează entitățile; cb(entityReader) decide ce decodează.
function eachEntity(buf, field, cb) {
  const r = new R(buf);
  let h = {};
  while (r.more()) {
    const f = r.key();
    if (f === 1) h = header(r.sub());
    else if (f === 2) {
      const e = r.sub();
      while (e.more()) {
        const g = e.key();
        if (g === field) cb(e.sub()); else e.skip();
      }
    } else r.skip();
  }
  return h;
}

const te = new TextEncoder();

// Compară octeții [s,e) cu un ID dorit, fără să creeze un șir.
function matchBytes(b, s, e, wantBytes) {
  const n = e - s;
  outer: for (const w of wantBytes) {
    if (w.length !== n) continue;
    for (let i = 0; i < n; i++) if (b[s + i] !== w[i]) continue outer;
    return true;
  }
  return false;
}

// Caută trip_id (câmpul 1) în TripDescriptor și întoarce [s,e) sau null.
function tripIdRange(r) {
  while (r.more()) { const f = r.key(); if (f === 1) return r.bytesEnd(); r.skip(); }
  return null;
}

// tripUpdates: dacă `want` (Set de trip_id) e dat, decodează doar acele curse,
// comparând ID-urile direct pe octeți.
export function decodeTripUpdates(buf, want) {
  const out = new Map();
  const wantBytes = want ? [...want].map((x) => te.encode(x)) : null;
  const h = eachEntity(buf, 3, (r) => {
    let trip = null; const stus = []; let ts, delay;
    while (r.more()) {
      const f = r.key();
      if (f === 1) {
        const sub = r.sub();
        if (wantBytes) {
          const rg = tripIdRange(new R(sub.b, sub.p, sub.end));
          if (!rg || !matchBytes(sub.b, rg[0], rg[1], wantBytes)) return;
        }
        trip = tripDesc(sub);
      } else if (f === 2) stus.push(stu(r.sub()));
      else if (f === 4) ts = r.varint();
      else if (f === 5) delay = r.int32();
      else r.skip();
    }
    if (trip) out.set(trip.tripId, { ...trip, ts, delay, stus });
  });
  return { header: h, trips: out };
}

// vehiclePositions: `keep(lat, lon, routeIdBytesRange, buf)` decide dacă
// vehiculul merită decodat complet (șirurile se decodează doar pentru cele păstrate).
export function decodeVehicles(buf, keep) {
  const out = [];
  const h = eachEntity(buf, 4, (r) => {
    let lat = 0, lon = 0, bearing, status, ts, trip = null, stop = null, veh = null;
    while (r.more()) {
      const f = r.key();
      if (f === 1) trip = r.bytesEnd();
      else if (f === 2) {
        const p = r.sub();
        while (p.more()) {
          const g = p.key();
          if (g === 1) lat = p.f32(); else if (g === 2) lon = p.f32(); else if (g === 3) bearing = p.f32(); else p.skip();
        }
      }
      else if (f === 4) status = r.varint();
      else if (f === 5) ts = r.varint();
      else if (f === 7) stop = r.bytesEnd();
      else if (f === 8) veh = r.bytesEnd();
      else r.skip();
    }
    if (!lat) return;
    let routeId, tripId;
    if (trip) {
      const t = new R(buf, trip[0], trip[1]);
      while (t.more()) {
        const g = t.key();
        if (g === 5) { const [s, e] = t.bytesEnd(); routeId = [s, e]; }
        else if (g === 1) { const [s, e] = t.bytesEnd(); tripId = [s, e]; }
        else t.skip();
      }
    }
    if (keep && !keep(lat, lon, routeId)) return;
    const v = { lat, lon, bearing, status, ts };
    if (tripId) v.tripId = td.decode(buf.subarray(tripId[0], tripId[1]));
    if (routeId) v.routeId = td.decode(buf.subarray(routeId[0], routeId[1]));
    if (stop) v.stopId = td.decode(buf.subarray(stop[0], stop[1]));
    if (veh) { const d = vehDesc(new R(buf, veh[0], veh[1])); v.id = d.id; v.label = d.label; }
    out.push(v);
  });
  return { header: h, vehicles: out };
}

// Ajutor pentru `keep`: potrivește routeId (interval de octeți) cu un set de ID-uri.
export function routeMatcher(ids) {
  const wb = [...ids].map((x) => te.encode(x));
  return (buf, rg) => !!rg && matchBytes(buf, rg[0], rg[1], wb);
}

function tstr(r) {
  let text = '', lang = '';
  while (r.more()) {
    const f = r.key();
    if (f === 1) {
      const t = r.sub(); let x = '', l = '';
      while (t.more()) { const g = t.key(); if (g === 1) x = t.str(); else if (g === 2) l = t.str(); else t.skip(); }
      if (!text || l === 'ro') { text = x; lang = l; }
    } else r.skip();
  }
  return text;
}

export function decodeAlerts(buf) {
  const out = [];
  const h = eachEntity(buf, 5, (r) => {
    const a = { routes: [], stops: [], periods: [] };
    while (r.more()) {
      const f = r.key();
      if (f === 1) {
        const p = r.sub(); const per = {};
        while (p.more()) { const g = p.key(); if (g === 1) per.start = p.varint(); else if (g === 2) per.end = p.varint(); else p.skip(); }
        a.periods.push(per);
      } else if (f === 5) {
        const s = r.sub();
        while (s.more()) { const g = s.key(); if (g === 2) a.routes.push(s.str()); else if (g === 5) a.stops.push(s.str()); else s.skip(); }
      } else if (f === 10) a.header = tstr(r.sub());
      else if (f === 11) a.text = tstr(r.sub());
      else r.skip();
    }
    out.push(a);
  });
  return { header: h, alerts: out };
}
