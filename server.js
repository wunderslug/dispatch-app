// Truck Dispatch — a small self-hosted dispatch board.
// No runtime dependencies: plain Node http server + a JSON file for storage.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const NOMINATIM_URL = (process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org').replace(/\/$/, '');
const OSRM_URL = (process.env.OSRM_URL || 'https://router.project-osrm.org').replace(/\/$/, '');
const GEOCODE_EMAIL = process.env.GEOCODE_EMAIL || '';
const TILE_URL = process.env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

// ---------- storage ----------

const DEFAULT_DB = {
  settings: {
    companyName: 'Building Supply',
    yard: { address: '', lat: null, lng: null },
  },
  trucks: [],
  orders: [],
};

let db;
function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.settings = { ...DEFAULT_DB.settings, ...(db.settings || {}) };
    db.trucks ||= [];
    db.orders ||= [];
  } else {
    db = structuredClone(DEFAULT_DB);
    saveDb();
  }
}

let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE); // atomic replace
  }, 50);
}

function flushDb() {
  clearTimeout(saveTimer);
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

const id = () => crypto.randomUUID().slice(0, 8);

// ---------- field cleaning ----------

const num = (v) => (v === '' || v === null || v === undefined || isNaN(Number(v)) ? null : Number(v));
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const bool = (v) => v === true || v === 'true' || v === 1 || v === 'on';

const TRUCK_TYPES = ['Boom truck', 'Flatbed', 'Flatbed + Moffett', 'Box truck', 'Pickup', 'Dump', 'Other'];
const ORDER_STATUSES = ['open', 'loaded', 'delivered'];

function cleanTruck(input, existing = {}) {
  const t = { ...existing };
  if ('name' in input) t.name = str(input.name) || 'Truck';
  if ('type' in input) t.type = TRUCK_TYPES.includes(input.type) ? input.type : 'Other';
  if ('maxWeight' in input) t.maxWeight = num(input.maxWeight);
  if ('maxLength' in input) t.maxLength = num(input.maxLength);
  if ('hasBoom' in input) t.hasBoom = bool(input.hasBoom);
  if ('hasForklift' in input) t.hasForklift = bool(input.hasForklift);
  if ('driver' in input) t.driver = str(input.driver);
  if ('color' in input) t.color = /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : '#2563eb';
  if ('active' in input) t.active = bool(input.active);
  if ('notes' in input) t.notes = str(input.notes);
  return t;
}

function cleanOrder(input, existing = {}) {
  const o = { ...existing };
  for (const k of ['customer', 'orderNo', 'phone', 'address', 'notes', 'windowStart', 'windowEnd', 'materials']) {
    if (k in input) o[k] = str(input[k]);
  }
  if ('date' in input) o.date = /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : o.date;
  if ('lat' in input) o.lat = num(input.lat);
  if ('lng' in input) o.lng = num(input.lng);
  if ('weight' in input) o.weight = num(input.weight);
  if ('length' in input) o.length = num(input.length);
  if ('needsBoom' in input) o.needsBoom = bool(input.needsBoom);
  if ('needsForklift' in input) o.needsForklift = bool(input.needsForklift);
  if ('status' in input) o.status = ORDER_STATUSES.includes(input.status) ? input.status : 'open';
  if ('truckId' in input) o.truckId = input.truckId ? String(input.truckId) : null;
  if ('trip' in input) o.trip = Math.max(1, Math.min(9, Number(input.trip) || 1));
  if ('seq' in input) o.seq = Number(input.seq) || 0;
  return o;
}

// ---------- http helpers ----------

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : headers['Content-Type'] || 'text/plain',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2e6) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

async function upstreamJson(url) {
  const headers = { 'User-Agent': `truck-dispatch/1.0 (self-hosted${GEOCODE_EMAIL ? '; ' + GEOCODE_EMAIL : ''})`, Accept: 'application/json' };
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Upstream ${r.status}`);
  return r.json();
}

// Simple in-memory caches so we don't hammer the free services.
const geoCache = new Map();
const routeCache = new Map();
let lastGeocodeAt = 0;

async function geocode(q) {
  const key = q.toLowerCase();
  if (geoCache.has(key)) return geoCache.get(key);
  // Nominatim usage policy: max 1 request / second.
  const wait = lastGeocodeAt + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeocodeAt = Date.now();
  const params = new URLSearchParams({ q, format: 'jsonv2', limit: '5', addressdetails: '0', countrycodes: process.env.GEOCODE_COUNTRIES || 'us' });
  if (GEOCODE_EMAIL) params.set('email', GEOCODE_EMAIL);
  const results = await upstreamJson(`${NOMINATIM_URL}/search?${params}`);
  const out = results.map((r) => ({ label: r.display_name, lat: Number(r.lat), lng: Number(r.lon) }));
  geoCache.set(key, out);
  return out;
}

async function route(points) {
  const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  if (routeCache.has(coords)) return routeCache.get(coords);
  const data = await upstreamJson(`${OSRM_URL}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`);
  if (data.code !== 'Ok' || !data.routes?.length) throw new Error('No route');
  const r = data.routes[0];
  const out = {
    distanceMiles: r.distance / 1609.344,
    durationMin: r.duration / 60,
    legs: r.legs.map((l) => ({ distanceMiles: l.distance / 1609.344, durationMin: l.duration / 60 })),
    line: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
  };
  if (routeCache.size > 500) routeCache.clear();
  routeCache.set(coords, out);
  return out;
}

// ---------- API ----------

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', resource, id?]
  const [, resource, rid, sub] = parts;
  const method = req.method;

  if (resource === 'config' && method === 'GET') {
    return send(res, 200, { tileUrl: TILE_URL, truckTypes: TRUCK_TYPES });
  }

  if (resource === 'state' && method === 'GET') {
    const date = url.searchParams.get('date');
    const orders = date ? db.orders.filter((o) => o.date === date) : db.orders;
    return send(res, 200, { settings: db.settings, trucks: db.trucks, orders });
  }

  if (resource === 'settings' && method === 'PUT') {
    const b = await readBody(req);
    if ('companyName' in b) db.settings.companyName = str(b.companyName) || 'Building Supply';
    if (b.yard) db.settings.yard = { address: str(b.yard.address), lat: num(b.yard.lat), lng: num(b.yard.lng) };
    saveDb();
    return send(res, 200, db.settings);
  }

  if (resource === 'trucks') {
    if (method === 'POST' && !rid) {
      const t = cleanTruck({ name: 'Truck', type: 'Flatbed', color: '#2563eb', active: true, hasBoom: false, hasForklift: false, ...(await readBody(req)) });
      t.id = id();
      t.sort = db.trucks.length;
      db.trucks.push(t);
      saveDb();
      return send(res, 201, t);
    }
    const idx = db.trucks.findIndex((t) => t.id === rid);
    if (idx === -1) return send(res, 404, { error: 'Truck not found' });
    if (method === 'PUT') {
      db.trucks[idx] = cleanTruck(await readBody(req), db.trucks[idx]);
      saveDb();
      return send(res, 200, db.trucks[idx]);
    }
    if (method === 'DELETE') {
      const [gone] = db.trucks.splice(idx, 1);
      for (const o of db.orders) if (o.truckId === gone.id && o.status !== 'delivered') { o.truckId = null; o.trip = 1; }
      saveDb();
      return send(res, 200, { ok: true });
    }
  }

  if (resource === 'orders') {
    if (method === 'POST' && !rid) {
      const b = await readBody(req);
      const o = cleanOrder({ status: 'open', truckId: null, trip: 1, seq: 0, needsBoom: false, needsForklift: false, ...b });
      if (!o.date) return send(res, 400, { error: 'date required' });
      o.id = id();
      o.createdAt = new Date().toISOString();
      db.orders.push(o);
      saveDb();
      return send(res, 201, o);
    }
    if (method === 'POST' && rid === 'move') {
      // Bulk placement after a drag: [{id, truckId, trip, seq}, ...]
      const b = await readBody(req);
      for (const m of b.moves || []) {
        const o = db.orders.find((x) => x.id === m.id);
        if (o) Object.assign(o, cleanOrder({ truckId: m.truckId, trip: m.trip, seq: m.seq }, o));
      }
      saveDb();
      return send(res, 200, { ok: true });
    }
    const idx = db.orders.findIndex((o) => o.id === rid);
    if (idx === -1) return send(res, 404, { error: 'Order not found' });
    if (method === 'PUT') {
      db.orders[idx] = cleanOrder(await readBody(req), db.orders[idx]);
      saveDb();
      return send(res, 200, db.orders[idx]);
    }
    if (method === 'DELETE') {
      db.orders.splice(idx, 1);
      saveDb();
      return send(res, 200, { ok: true });
    }
  }

  if (resource === 'geocode' && method === 'GET') {
    const q = str(url.searchParams.get('q'));
    if (q.length < 3) return send(res, 200, []);
    try { return send(res, 200, await geocode(q)); }
    catch (e) { return send(res, 502, { error: 'Geocoding failed: ' + e.message }); }
  }

  if (resource === 'route' && method === 'POST') {
    const b = await readBody(req);
    const pts = (b.points || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (pts.length < 2) return send(res, 400, { error: 'Need at least 2 points' });
    if (pts.length > 60) return send(res, 400, { error: 'Too many stops' });
    try { return send(res, 200, await route(pts)); }
    catch (e) { return send(res, 502, { error: 'Routing failed: ' + e.message }); }
  }

  if (resource === 'export' && method === 'GET') {
    return send(res, 200, db, { 'Content-Disposition': `attachment; filename="dispatch-backup-${new Date().toISOString().slice(0, 10)}.json"` });
  }

  if (resource === 'import' && method === 'POST') {
    const b = await readBody(req);
    if (!Array.isArray(b.trucks) || !Array.isArray(b.orders)) return send(res, 400, { error: 'Not a dispatch backup file' });
    db = { settings: { ...DEFAULT_DB.settings, ...(b.settings || {}) }, trucks: b.trucks, orders: b.orders };
    flushDb();
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Not found' });
}

// ---------- server ----------

loadDb();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    return send(res, 400, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`Truck Dispatch running on http://0.0.0.0:${PORT} (data: ${DB_FILE})`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { flushDb(); } catch {} process.exit(0); });
}
