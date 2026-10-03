// Dispatch — self-hosted delivery dispatch board for a building supply yard.
// No npm dependencies: Node http server + one JSON file for storage + ticket images on disk.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Shared = require('./public/shared.js');
const { readTicket } = require('./ticket-reader.js');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const IMG_DIR = path.join(DATA_DIR, 'tickets');
const PUBLIC_DIR = path.join(__dirname, 'public');
const NOMINATIM_URL = (process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org').replace(/\/$/, '');
const OSRM_URL = (process.env.OSRM_URL || 'https://router.project-osrm.org').replace(/\/$/, '');
const GEOCODE_EMAIL = process.env.GEOCODE_EMAIL || '';
const TILE_URL = process.env.TILE_URL || 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const ENV_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// ------------------------------------------------------------------ storage

const DEFAULT_DB = {
  settings: { companyName: 'Building Supply', yard: { address: '', lat: null, lng: null }, ticketReader: 'auto', claudeApiKey: '' },
  trucks: [],
  orders: [],
  lingo: [],
};

let db;
function loadDb() {
  fs.mkdirSync(IMG_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.settings = { ...DEFAULT_DB.settings, ...(db.settings || {}) };
    db.trucks ||= [];
    db.orders ||= [];
    db.lingo ||= [];
  } else {
    db = structuredClone(DEFAULT_DB);
    flushDb();
  }
}
let saveTimer = null;
function writeNow() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
function saveDb() { clearTimeout(saveTimer); saveTimer = setTimeout(writeNow, 50); }
function flushDb() { clearTimeout(saveTimer); writeNow(); }

const id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);
const num = (v) => (v === '' || v === null || v === undefined || isNaN(Number(v)) ? null : Number(v));
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const bool = (v) => v === true || v === 'true' || v === 1 || v === 'on';
const triBool = (v) => (v === true || v === 'yes' ? true : v === false || v === 'no' ? false : null);

const TRUCK_TYPES = ['Boom truck', 'Flatbed + Moffett', 'Flatbed', 'Box truck', 'Pickup', 'Dump', 'Other'];
const STATUSES = ['open', 'loaded', 'delivered'];
const PRIORITIES = ['rush', 'normal', 'low'];

function cleanTruck(input, t = {}) {
  t = { ...t };
  if ('name' in input) t.name = str(input.name) || 'Truck';
  if ('type' in input) t.type = TRUCK_TYPES.includes(input.type) ? input.type : 'Other';
  for (const k of ['maxLength', 'maxStops', 'maxTrips', 'maxWeight']) if (k in input) t[k] = num(input[k]);
  for (const k of ['hasBoom', 'hasForklift', 'covered', 'active']) if (k in input) t[k] = bool(input[k]);
  if ('driver' in input) t.driver = str(input.driver);
  if ('code' in input) t.code = str(input.code).toUpperCase().slice(0, 4);
  if ('color' in input) t.color = /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : '#2563eb';
  if ('sort' in input) t.sort = Number(input.sort) || 0;
  return t;
}

function cleanLine(l) {
  return { qty: num(l.qty), uom: str(l.uom), sku: str(l.sku), desc: str(l.desc), lengthFt: num(l.lengthFt), ignore: bool(l.ignore) };
}

function cleanOrder(input, o = {}) {
  o = { ...o };
  for (const k of ['customer', 'orderNo', 'phone', 'address', 'notes', 'instructions', 'windowStart', 'windowEnd', 'planReason']) if (k in input) o[k] = str(input[k]);
  if ('date' in input && /^\d{4}-\d{2}-\d{2}$/.test(input.date)) o.date = input.date;
  if ('lat' in input) o.lat = num(input.lat);
  if ('lng' in input) o.lng = num(input.lng);
  if ('status' in input) o.status = STATUSES.includes(input.status) ? input.status : 'open';
  if ('priority' in input) o.priority = PRIORITIES.includes(input.priority) ? input.priority : 'normal';
  if ('truckId' in input) o.truckId = input.truckId ? String(input.truckId) : null;
  if ('trip' in input) o.trip = Math.max(1, Math.min(9, Number(input.trip) || 1));
  if ('seq' in input) o.seq = Number(input.seq) || 0;
  if ('assign' in input) o.assign = ['proposed', 'confirmed'].includes(input.assign) ? input.assign : null;
  if ('lines' in input && Array.isArray(input.lines)) o.lines = input.lines.map(cleanLine).filter((l) => l.sku || l.desc);
  if ('overrides' in input && input.overrides) {
    const ov = input.overrides;
    o.overrides = { boom: triBool(ov.boom), moffett: triBool(ov.moffett), covered: triBool(ov.covered), lengthFt: num(ov.lengthFt) };
  }
  if ('imageIds' in input && Array.isArray(input.imageIds)) o.imageIds = input.imageIds.filter((x) => /^[a-f0-9]{10}$/.test(x));
  if ('source' in input) o.source = ['photo', 'csv', 'manual'].includes(input.source) ? input.source : 'manual';
  if (!o.truckId) { o.assign = null; }
  // a new address means the old map location is stale
  if ('address' in input && !('lat' in input) && str(input.address) !== str(o._geoFor)) { o.lat = null; o.lng = null; }
  if ('lat' in input && o.lat != null) o._geoFor = o.address;
  return o;
}

function newOrder(input) {
  const o = cleanOrder({ status: 'open', priority: 'normal', truckId: null, trip: 1, seq: 0, lines: [], source: 'manual', ...input });
  o.id = id();
  o.createdAt = new Date().toISOString();
  if (!o.date) o.date = new Date().toISOString().slice(0, 10);
  return o;
}

function cleanRule(input, r = {}) {
  r = { ...r };
  if ('match' in input) r.match = ['sku', 'prefix', 'contains'].includes(input.match) ? input.match : 'contains';
  if ('scope' in input) r.scope = input.scope === 'ticket' ? 'ticket' : 'line';
  if ('pattern' in input) r.pattern = str(input.pattern).toUpperCase();
  if ('meaning' in input) r.meaning = str(input.meaning);
  if ('lengthFt' in input) r.lengthFt = num(input.lengthFt);
  for (const k of ['boom', 'moffett', 'covered', 'ignore']) if (k in input) r[k] = bool(input[k]);
  if (r.scope === 'ticket') r.match = 'contains';
  return r;
}

const publicSettings = () => {
  const { claudeApiKey, ...rest } = db.settings;
  return { ...rest, hasApiKey: !!(claudeApiKey || ENV_API_KEY), apiKeyFromEnv: !!ENV_API_KEY };
};

// ------------------------------------------------------------------ http helpers

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain', 'Cache-Control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readBody(req, limit = 2e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Upload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const data = Buffer.concat(chunks).toString('utf8');
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

function serveStatic(res, urlPath) {
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

// ------------------------------------------------------------------ geocoding + routing

async function upstreamJson(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': `dispatch-app/2.0 (self-hosted${GEOCODE_EMAIL ? '; ' + GEOCODE_EMAIL : ''})`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Upstream ${r.status}`);
  return r.json();
}

const geoCache = new Map();
let lastGeocodeAt = 0;
let geoChain = Promise.resolve();

function geocode(q) {
  const key = q.toLowerCase();
  if (geoCache.has(key)) return Promise.resolve(geoCache.get(key));
  // Nominatim policy: one request per second, so calls are queued.
  const p = geoChain.then(async () => {
    if (geoCache.has(key)) return geoCache.get(key);
    const wait = lastGeocodeAt + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastGeocodeAt = Date.now();
    const params = new URLSearchParams({ q, format: 'jsonv2', limit: '5', countrycodes: process.env.GEOCODE_COUNTRIES || 'us' });
    if (GEOCODE_EMAIL) params.set('email', GEOCODE_EMAIL);
    const out = (await upstreamJson(`${NOMINATIM_URL}/search?${params}`)).map((r) => ({ label: r.display_name, lat: Number(r.lat), lng: Number(r.lon) }));
    geoCache.set(key, out);
    return out;
  });
  geoChain = p.catch(() => {});
  return p;
}

/** Locate every order that has an address but no map position yet. */
const geoFailed = new Set();
async function locatePending() {
  const pending = db.orders.filter((o) => o.address && !Shared.hasGeo(o) && !geoFailed.has(o.id + '|' + o.address));
  for (const o of pending) {
    try {
      const [hit] = await geocode(o.address);
      const cur = db.orders.find((x) => x.id === o.id);
      if (!cur || cur.address !== o.address) continue;
      if (hit) { cur.lat = hit.lat; cur.lng = hit.lng; cur._geoFor = cur.address; saveDb(); }
      else geoFailed.add(o.id + '|' + o.address);
    } catch { geoFailed.add(o.id + '|' + o.address); }
  }
}
let locating = null;
function kickLocate() { if (!locating) locating = locatePending().finally(() => { locating = null; }); return locating; }

const routeCache = new Map();
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

// ------------------------------------------------------------------ API

async function api(req, res, url) {
  const [, resource, rid] = url.pathname.split('/').filter(Boolean);
  const method = req.method;

  if (resource === 'config' && method === 'GET') return send(res, 200, { tileUrl: TILE_URL, truckTypes: TRUCK_TYPES });

  if (resource === 'state' && method === 'GET') {
    const date = url.searchParams.get('date');
    const orders = date ? db.orders.filter((o) => o.date === date) : db.orders;
    return send(res, 200, { settings: publicSettings(), trucks: db.trucks, orders, lingo: db.lingo });
  }

  if (resource === 'settings' && method === 'PUT') {
    const b = await readBody(req);
    if ('companyName' in b) db.settings.companyName = str(b.companyName) || 'Building Supply';
    if (b.yard) db.settings.yard = { address: str(b.yard.address), lat: num(b.yard.lat), lng: num(b.yard.lng) };
    if ('ticketReader' in b) db.settings.ticketReader = ['auto', 'claude', 'tesseract'].includes(b.ticketReader) ? b.ticketReader : 'auto';
    if ('claudeApiKey' in b && b.claudeApiKey !== '********') db.settings.claudeApiKey = str(b.claudeApiKey);
    saveDb();
    return send(res, 200, publicSettings());
  }

  // ---- trucks
  if (resource === 'trucks') {
    if (method === 'POST' && !rid) {
      const t = cleanTruck({ name: 'Truck', type: 'Flatbed', color: '#2563eb', active: true, hasBoom: false, hasForklift: false, covered: false, maxStops: 5, maxTrips: 3, ...(await readBody(req)) });
      t.id = id();
      t.sort = db.trucks.length;
      db.trucks.push(t);
      saveDb();
      return send(res, 201, t);
    }
    const idx = db.trucks.findIndex((t) => t.id === rid);
    if (idx === -1) return send(res, 404, { error: 'Truck not found' });
    if (method === 'PUT') { db.trucks[idx] = cleanTruck(await readBody(req), db.trucks[idx]); saveDb(); return send(res, 200, db.trucks[idx]); }
    if (method === 'DELETE') {
      const [gone] = db.trucks.splice(idx, 1);
      for (const o of db.orders) if (o.truckId === gone.id && o.status !== 'delivered') Object.assign(o, { truckId: null, trip: 1, assign: null });
      saveDb();
      return send(res, 200, { ok: true });
    }
  }

  // ---- orders
  if (resource === 'orders') {
    if (method === 'POST' && !rid) {
      const o = newOrder(await readBody(req));
      db.orders.push(o);
      saveDb();
      kickLocate();
      return send(res, 201, o);
    }
    if (method === 'POST' && rid === 'bulk') {
      const b = await readBody(req, 10e6);
      const created = [], skipped = [];
      for (const input of b.orders || []) {
        if (input.orderNo && db.orders.some((o) => o.orderNo && o.orderNo === str(input.orderNo) && o.date === input.date)) { skipped.push(input.orderNo); continue; }
        const o = newOrder(input);
        db.orders.push(o);
        created.push(o);
      }
      saveDb();
      kickLocate();
      return send(res, 200, { created: created.length, skipped });
    }
    if (method === 'POST' && rid === 'move') {
      const b = await readBody(req);
      for (const m of b.moves || []) {
        const o = db.orders.find((x) => x.id === m.id);
        if (o) Object.assign(o, cleanOrder(m, o));
      }
      saveDb();
      return send(res, 200, { ok: true });
    }
    const idx = db.orders.findIndex((o) => o.id === rid);
    if (idx === -1) return send(res, 404, { error: 'Order not found' });
    if (method === 'PUT') { db.orders[idx] = cleanOrder(await readBody(req), db.orders[idx]); saveDb(); kickLocate(); return send(res, 200, db.orders[idx]); }
    if (method === 'DELETE') { db.orders.splice(idx, 1); saveDb(); return send(res, 200, { ok: true }); }
  }

  // ---- translator rules
  if (resource === 'lingo') {
    if (method === 'POST' && !rid) {
      const r = cleanRule({ match: 'sku', scope: 'line', boom: false, moffett: false, covered: false, ignore: false, lengthFt: null, meaning: '', ...(await readBody(req)) });
      if (!r.pattern) return send(res, 400, { error: 'Pattern required' });
      const dup = db.lingo.find((x) => x.match === r.match && x.scope === r.scope && x.pattern === r.pattern);
      if (dup) { Object.assign(dup, r); saveDb(); return send(res, 200, dup); }
      r.id = id();
      r.createdAt = new Date().toISOString();
      db.lingo.push(r);
      saveDb();
      return send(res, 201, r);
    }
    const idx = db.lingo.findIndex((r) => r.id === rid);
    if (idx === -1) return send(res, 404, { error: 'Rule not found' });
    if (method === 'PUT') { db.lingo[idx] = cleanRule(await readBody(req), db.lingo[idx]); saveDb(); return send(res, 200, db.lingo[idx]); }
    if (method === 'DELETE') { db.lingo.splice(idx, 1); saveDb(); return send(res, 200, { ok: true }); }
  }

  // ---- read a ticket photo / PDF
  if (resource === 'read-ticket' && method === 'POST') {
    const b = await readBody(req, 30e6);
    const m = /^data:(image\/(?:jpeg|png|webp|gif)|application\/pdf);base64,(.+)$/.exec(b.data || '');
    if (!m) return send(res, 400, { error: 'Send a JPEG, PNG or PDF' });
    const buf = Buffer.from(m[2], 'base64');
    const imageId = id();
    const ext = m[1] === 'application/pdf' ? 'pdf' : m[1].split('/')[1].replace('jpeg', 'jpg');
    fs.writeFileSync(path.join(IMG_DIR, `${imageId}.${ext}`), buf);
    try {
      const out = await readTicket(buf, m[1], { engine: db.settings.ticketReader, apiKey: db.settings.claudeApiKey || ENV_API_KEY });
      return send(res, 200, { imageId, ...out });
    } catch (e) {
      return send(res, 200, { imageId, error: e.message, parsed: { orderNo: '', customer: '', phone: '', address: '', date: '', instructions: '', lines: [] }, rawText: '' });
    }
  }

  if (resource === 'tickets' && method === 'GET' && /^[a-f0-9]{10}$/.test(rid || '')) {
    const f = fs.readdirSync(IMG_DIR).find((n) => n.startsWith(rid + '.'));
    if (!f) return send(res, 404, 'Not found');
    const type = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf' }[f.split('.').pop()];
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' });
    return fs.createReadStream(path.join(IMG_DIR, f)).pipe(res);
  }

  // ---- auto-dispatch
  if (resource === 'plan' && method === 'POST') {
    const b = await readBody(req);
    const date = b.date;
    await Promise.race([kickLocate(), new Promise((r) => setTimeout(r, 20000))]); // locate what we can first
    const orders = db.orders.filter((o) => o.date === date);
    const { assignments, unplaced } = Shared.planDay({ orders, trucks: db.trucks, yard: db.settings.yard, rules: db.lingo });
    for (const a of assignments) {
      const o = db.orders.find((x) => x.id === a.id);
      if (!o) continue;
      if (a.keep) Object.assign(o, { trip: a.trip, seq: a.seq });
      else Object.assign(o, { truckId: a.truckId, trip: a.trip, seq: a.seq, assign: 'proposed', planReason: a.reason });
    }
    for (const u of unplaced) {
      const o = db.orders.find((x) => x.id === u.id);
      if (o) Object.assign(o, { truckId: null, trip: 1, assign: null, planReason: u.reason });
    }
    saveDb();
    return send(res, 200, { proposed: assignments.filter((a) => !a.keep).length, unplaced: unplaced.length });
  }

  if (resource === 'accept' && method === 'POST') {
    const b = await readBody(req);
    let n = 0;
    for (const o of db.orders) {
      if (o.date !== b.date || o.assign !== 'proposed') continue;
      if (b.truckId && o.truckId !== b.truckId) continue;
      if (b.orderId && o.id !== b.orderId) continue;
      o.assign = 'confirmed';
      n++;
    }
    saveDb();
    return send(res, 200, { accepted: n });
  }

  if (resource === 'clear-proposals' && method === 'POST') {
    const b = await readBody(req);
    for (const o of db.orders) if (o.date === b.date && o.assign === 'proposed') Object.assign(o, { truckId: null, trip: 1, assign: null, planReason: '' });
    saveDb();
    return send(res, 200, { ok: true });
  }

  if (resource === 'geocode' && method === 'GET') {
    const q = str(url.searchParams.get('q'));
    if (q.length < 3) return send(res, 200, []);
    try { return send(res, 200, await geocode(q)); } catch (e) { return send(res, 502, { error: 'Address lookup failed: ' + e.message }); }
  }

  if (resource === 'route' && method === 'POST') {
    const b = await readBody(req);
    const pts = (b.points || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (pts.length < 2 || pts.length > 60) return send(res, 400, { error: 'Need 2–60 points' });
    try { return send(res, 200, await route(pts)); } catch (e) { return send(res, 502, { error: 'Routing failed: ' + e.message }); }
  }

  if (resource === 'export' && method === 'GET') {
    const { claudeApiKey, ...settings } = db.settings;
    return send(res, 200, { ...db, settings }, { 'Content-Disposition': `attachment; filename="dispatch-backup-${new Date().toISOString().slice(0, 10)}.json"` });
  }

  if (resource === 'import' && method === 'POST') {
    const b = await readBody(req, 50e6);
    if (!Array.isArray(b.trucks) || !Array.isArray(b.orders)) return send(res, 400, { error: 'Not a dispatch backup file' });
    const key = db.settings.claudeApiKey;
    db = { settings: { ...DEFAULT_DB.settings, ...(b.settings || {}), claudeApiKey: key }, trucks: b.trucks, orders: b.orders, lingo: b.lingo || [] };
    flushDb();
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Not found' });
}

// ------------------------------------------------------------------ server

loadDb();
kickLocate();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
    return serveStatic(res, url.pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 400, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`Dispatch running on http://0.0.0.0:${PORT} (data: ${DATA_DIR})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { flushDb(); } catch {} process.exit(0); });
