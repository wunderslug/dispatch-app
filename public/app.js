/* Dispatch board — front end. Plain JS, no build step. */
(() => {
'use strict';

// ---------------------------------------------------------------- state
const S = {
  date: todayStr(),
  settings: { companyName: '', yard: {} },
  trucks: [],
  orders: [],
  config: { tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', truckTypes: [] },
  selected: null,      // order id
  focusTruck: null,    // truck id highlighted on the map
  hidden: new Set(),   // truck ids hidden on map ('_u' = unassigned)
  routes: new Map(),   // coord key -> route result | 'pending' | 'fail'
  dragging: null,
  lastHash: '',
};

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtLb = (n) => (n == null ? '—' : Math.round(n).toLocaleString() + ' lb');
const UNASSIGNED_COLOR = '#8a939f';

function todayStr(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
function shiftDate(str, days) {
  const [y, m, d] = str.split('-').map(Number);
  return todayStr(new Date(y, m - 1, d + days));
}
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h < 12 ? 'a' : 'p'}`;
}
function fmtMin(min) {
  if (min == null) return '';
  const m = Math.round(min);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
function niceDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
}

async function api(path, opts = {}) {
  const r = await fetch('api/' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 2600);
}

// ---------------------------------------------------------------- derived data
const truckById = (id) => S.trucks.find((t) => t.id === id);
const truckColor = (id) => truckById(id)?.color || UNASSIGNED_COLOR;
const hasGeo = (o) => Number.isFinite(o.lat) && Number.isFinite(o.lng);
const yardGeo = () => (Number.isFinite(S.settings.yard?.lat) && Number.isFinite(S.settings.yard?.lng) ? S.settings.yard : null);
const bySeq = (a, b) => (a.seq ?? 0) - (b.seq ?? 0) || (a.createdAt || '').localeCompare(b.createdAt || '');

/** Columns for the board: unassigned + each active truck (+ inactive trucks that have orders today). */
function buildColumns() {
  const cols = [];
  const unassigned = S.orders.filter((o) => !o.truckId || !truckById(o.truckId)).sort(bySeq);
  cols.push({ truck: null, trips: [{ n: 1, orders: unassigned }] });
  const trucks = [...S.trucks].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  for (const t of trucks) {
    const mine = S.orders.filter((o) => o.truckId === t.id);
    if (!t.active && !mine.length) continue;
    const tripNos = [...new Set(mine.map((o) => o.trip || 1))].sort((a, b) => a - b);
    const trips = tripNos.map((n) => ({ n, orders: mine.filter((o) => (o.trip || 1) === n).sort(bySeq) }));
    cols.push({ truck: t, trips });
  }
  return cols;
}

/** Problems with putting order o on truck t. */
function orderWarnings(o, t) {
  const w = [];
  if (!hasGeo(o)) w.push({ soft: true, text: 'Not on map — address not located' });
  if (!t) return w;
  if (o.needsBoom && !t.hasBoom) w.push({ text: `Needs boom — ${t.name} has none` });
  if (o.needsForklift && !t.hasForklift) w.push({ text: `Needs Moffett — ${t.name} has none` });
  if (o.length != null && t.maxLength != null && o.length > t.maxLength) w.push({ text: `${o.length}' material, deck is ${t.maxLength}'` });
  if (o.weight != null && t.maxWeight != null && o.weight > t.maxWeight) w.push({ text: `${fmtLb(o.weight)} alone exceeds ${fmtLb(t.maxWeight)}` });
  return w;
}

function tripLoad(trip, t) {
  const weight = trip.orders.reduce((s, o) => s + (o.weight || 0), 0);
  const unknown = trip.orders.some((o) => o.weight == null);
  const pct = t?.maxWeight ? weight / t.maxWeight : null;
  return { weight, unknown, pct, over: pct != null && pct > 1 };
}

function tripPoints(trip) {
  const stops = trip.orders.filter(hasGeo);
  const yard = yardGeo();
  const pts = stops.map((o) => ({ lat: o.lat, lng: o.lng, id: o.id }));
  if (yard) { pts.unshift({ lat: yard.lat, lng: yard.lng, id: '_yard' }); pts.push({ lat: yard.lat, lng: yard.lng, id: '_yard' }); }
  return pts;
}
const routeKey = (pts) => pts.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(';');

// ---------------------------------------------------------------- board render
function render() {
  renderStats();
  renderBoard();
  renderMap();
}

function renderStats() {
  $('#companyName').textContent = S.settings.companyName || 'Dispatch';
  document.title = `Dispatch — ${niceDate(S.date)}`;
  const total = S.orders.length;
  const unassigned = S.orders.filter((o) => !o.truckId || !truckById(o.truckId)).length;
  const delivered = S.orders.filter((o) => o.status === 'delivered').length;
  const weight = S.orders.reduce((s, o) => s + (o.weight || 0), 0);
  let problems = 0;
  for (const col of buildColumns()) {
    if (!col.truck) continue;
    for (const trip of col.trips) {
      if (tripLoad(trip, col.truck).over) problems++;
      for (const o of trip.orders) problems += orderWarnings(o, col.truck).filter((w) => !w.soft).length;
    }
  }
  $('#dayStats').innerHTML = `
    <span><b>${total}</b> orders</span>
    <span class="${unassigned ? 'bad' : ''}"><b>${unassigned}</b> unassigned</span>
    <span><b>${delivered}</b> delivered</span>
    <span><b>${Math.round(weight).toLocaleString()}</b> lb</span>
    ${problems ? `<span class="bad"><b>${problems}</b> problem${problems > 1 ? 's' : ''}</span>` : ''}`;
}

function renderBoard() {
  const board = $('#board');
  const scroll = board.scrollLeft;
  const colScroll = Object.fromEntries($$('.col', board).map((c) => [c.dataset.truck, $('.colBody', c)?.scrollTop || 0]));
  board.innerHTML = '';
  for (const col of buildColumns()) board.appendChild(renderColumn(col));
  board.scrollLeft = scroll;
  for (const c of $$('.col', board)) { const b = $('.colBody', c); if (b) b.scrollTop = colScroll[c.dataset.truck] || 0; }
  if (S.trucks.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'col';
    hint.innerHTML = `<div class="colHead"><div class="name">No trucks yet</div><div class="sub">Add your fleet so you can assign orders.</div></div>
      <div class="colBody"><button class="btn primary" id="firstTruck">+ Add trucks</button></div>`;
    board.appendChild(hint);
    $('#firstTruck').onclick = openTrucks;
  }
}

function renderColumn({ truck, trips }) {
  const col = document.createElement('div');
  col.className = 'col' + (truck && S.focusTruck === truck.id ? ' focus' : '');
  col.dataset.truck = truck ? truck.id : '';
  col.style.setProperty('--tc', truck ? truck.color : UNASSIGNED_COLOR);

  const count = trips.reduce((s, t) => s + t.orders.length, 0);
  const head = document.createElement('div');
  head.className = 'colHead';
  if (truck) {
    const tags = [truck.type && `<span class="tag">${esc(truck.type)}</span>`, truck.hasBoom && '<span class="tag boom">Boom</span>', truck.hasForklift && '<span class="tag fork">Moffett</span>'].filter(Boolean).join('');
    head.innerHTML = `
      <div class="row1"><span class="name">${esc(truck.name)}</span>
        <button class="btn icon" data-act="print" title="Print run sheet">⎙</button></div>
      <div class="sub">${esc(truck.driver || 'No driver set')} · ${fmtLb(truck.maxWeight)}${truck.maxLength ? ` · ${truck.maxLength}' deck` : ''}${truck.active ? '' : ' · <b>off board</b>'}</div>
      <div class="tags" style="margin-top:4px">${tags}</div>`;
    head.title = 'Click to show this truck on the map';
    head.addEventListener('click', (e) => {
      if (e.target.closest('[data-act=print]')) return printRunSheet(truck.id);
      S.focusTruck = S.focusTruck === truck.id ? null : truck.id;
      renderBoard(); renderMap(true);
    });
  } else {
    head.innerHTML = `<div class="row1"><span class="name">Unassigned</span><span class="muted">${count}</span>
      <button class="btn small primary" data-act="new">+ Order</button></div>
      <div class="sub">Drag orders onto a truck</div>`;
    head.querySelector('[data-act=new]').onclick = (e) => { e.stopPropagation(); openOrder(null); };
  }
  col.appendChild(head);

  const body = document.createElement('div');
  body.className = 'colBody';
  if (!truck) {
    body.appendChild(dropZone(trips[0].orders, null, 1, 'No unassigned orders'));
  } else {
    for (const trip of trips) body.appendChild(renderTrip(trip, truck, trips.length));
    const nextN = (trips.at(-1)?.n || 0) + 1;
    const empty = document.createElement('div');
    empty.className = 'trip newTrip';
    empty.appendChild(dropZone([], truck.id, nextN, trips.length ? '+ Drop here for another trip' : 'Drop orders here for trip 1'));
    body.appendChild(empty);
  }
  col.appendChild(body);
  return col;
}

function renderTrip(trip, truck, tripCount) {
  const el = document.createElement('div');
  const load = tripLoad(trip, truck);
  el.className = 'trip' + (load.over ? ' over' : '');
  const pts = tripPoints(trip);
  const rt = pts.length >= 2 ? S.routes.get(routeKey(pts)) : null;
  const routeTxt = rt && typeof rt === 'object' ? ` · ${rt.distanceMiles.toFixed(0)} mi · ${fmtMin(rt.durationMin)} drive` : '';
  const pct = load.pct != null ? Math.min(100, load.pct * 100) : 0;
  el.innerHTML = `
    <div class="tripHead">
      <span class="t">Trip ${tripCount > 1 || trip.n > 1 ? trip.n : 1}</span>
      <span class="meta">${fmtLb(load.weight)}${load.unknown ? '+' : ''}${truck.maxWeight ? ` / ${Math.round(truck.maxWeight).toLocaleString()}` : ''}<span data-route>${routeTxt}</span></span>
      <span class="tripTools">
        ${trip.orders.length > 1 ? '<button class="btn icon" data-act="opt" title="Re-order stops by shortest drive">⇅</button>' : ''}
      </span>
    </div>
    ${truck.maxWeight ? `<div class="loadBar"><i class="${load.over ? 'full' : pct > 85 ? 'mid' : ''}" style="width:${pct}%"></i></div>` : ''}
    ${load.over ? `<div class="warns" style="margin:6px 8px 0"><div class="warn">Over payload by ${fmtLb(load.weight - truck.maxWeight)}</div></div>` : ''}`;
  const opt = el.querySelector('[data-act=opt]');
  if (opt) opt.onclick = () => optimizeTrip(truck.id, trip.n);
  el.appendChild(dropZone(trip.orders, truck.id, trip.n, 'Drop orders here', rt));
  return el;
}

function dropZone(orders, truckId, tripN, hint, rt) {
  const z = document.createElement('div');
  z.className = 'dropZone' + (orders.length ? '' : ' empty');
  z.dataset.truck = truckId || '';
  z.dataset.trip = tripN;
  z.dataset.hint = hint;
  const truck = truckId ? truckById(truckId) : null;
  // map each geocoded stop to its inbound leg time
  const legs = {};
  if (rt && typeof rt === 'object') {
    const geoStops = orders.filter(hasGeo);
    const offset = yardGeo() ? 0 : -1;
    geoStops.forEach((o, i) => { const leg = rt.legs[i + offset]; if (leg) legs[o.id] = leg.durationMin; });
  }
  orders.forEach((o, i) => z.appendChild(renderCard(o, truck, i + 1, tripN, legs[o.id])));

  z.addEventListener('dragover', (e) => {
    if (!S.dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    z.classList.add('over');
  });
  z.addEventListener('dragleave', (e) => { if (!z.contains(e.relatedTarget)) z.classList.remove('over'); });
  z.addEventListener('drop', (e) => {
    e.preventDefault();
    z.classList.remove('over');
    const id = S.dragging;
    if (!id) return;
    const cards = $$('.card', z).filter((c) => c.dataset.id !== id);
    let idx = cards.length;
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { idx = i; break; }
    }
    moveOrder(id, truckId || null, Number(tripN), cards.map((c) => c.dataset.id), idx);
  });
  return z;
}

function renderCard(o, truck, stopNo, tripN, legMin) {
  const c = document.createElement('div');
  c.className = 'card' + (S.selected === o.id ? ' sel' : '') + (o.status === 'delivered' ? ' delivered' : '');
  c.draggable = true;
  c.dataset.id = o.id;
  c.style.setProperty('--tc', truck ? truck.color : UNASSIGNED_COLOR);
  const warns = orderWarnings(o, truck);
  const win = o.windowStart || o.windowEnd ? `${fmtTime(o.windowStart) || '…'}–${fmtTime(o.windowEnd) || '…'}` : '';
  const shortAddr = (o.address || '').split(',').slice(0, 2).join(',');
  c.innerHTML = `
    <div class="top">
      ${truck ? `<span class="stop">${stopNo}</span>` : ''}
      <span class="cust">${esc(o.customer || 'Untitled')}</span>
      ${o.orderNo ? `<span class="ono">#${esc(o.orderNo)}</span>` : ''}
    </div>
    <div class="addr">${shortAddr ? esc(shortAddr) : '<span class="nogeo">No address</span>'}</div>
    <div class="facts">
      ${o.weight != null ? `<span>${fmtLb(o.weight)}</span>` : '<span class="muted">wt ?</span>'}
      ${o.length != null ? `<span>${o.length}'</span>` : ''}
      ${win ? `<span>⏱ ${win}</span>` : ''}
      ${legMin != null ? `<span class="muted">${fmtMin(legMin)}</span>` : ''}
      ${o.needsBoom ? '<span class="tag boom">Boom</span>' : ''}
      ${o.needsForklift ? '<span class="tag fork">Moffett</span>' : ''}
      ${o.status !== 'open' ? `<span class="status ${o.status}">${o.status}</span>` : ''}
    </div>
    ${warns.length ? `<div class="warns">${warns.map((w) => `<div class="warn ${w.soft ? 'soft' : ''}">${esc(w.text)}</div>`).join('')}</div>` : ''}`;
  c.title = 'Click to find on map · double-click to edit';

  c.addEventListener('dragstart', (e) => {
    S.dragging = o.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', o.id);
    requestAnimationFrame(() => c.classList.add('dragging'));
  });
  c.addEventListener('dragend', () => { S.dragging = null; c.classList.remove('dragging'); $$('.dropZone.over').forEach((z) => z.classList.remove('over')); });
  c.addEventListener('click', () => selectOrder(o.id, true));
  c.addEventListener('dblclick', () => openOrder(o.id));
  return c;
}

function selectOrder(id, pan) {
  S.selected = S.selected === id && !pan ? null : id;
  $$('.card').forEach((c) => c.classList.toggle('sel', c.dataset.id === S.selected));
  const o = S.orders.find((x) => x.id === id);
  if (pan && o && hasGeo(o)) {
    map.setView([o.lat, o.lng], Math.max(map.getZoom(), 13), { animate: true });
    markers.get(id)?.openPopup();
  }
}

// ---------------------------------------------------------------- moving orders
async function moveOrder(id, truckId, tripN, zoneIds, idx) {
  const o = S.orders.find((x) => x.id === id);
  if (!o) return;
  const ids = [...zoneIds];
  ids.splice(idx, 0, id);
  o.truckId = truckId;
  o.trip = tripN;
  const moves = ids.map((oid, i) => {
    const ord = S.orders.find((x) => x.id === oid);
    ord.seq = i; ord.truckId = truckId; ord.trip = tripN;
    return { id: oid, truckId, trip: tripN, seq: i };
  });
  moves.push(...compactTrips());
  render();
  try { await api('orders/move', { method: 'POST', body: { moves } }); }
  catch (e) { toast(e.message, true); refresh(); }
}

/** Renumber trips so each truck's trips run 1..n with no gaps. Returns moves for changed orders. */
function compactTrips() {
  const moves = [];
  for (const t of S.trucks) {
    const mine = S.orders.filter((o) => o.truckId === t.id);
    const nos = [...new Set(mine.map((o) => o.trip || 1))].sort((a, b) => a - b);
    nos.forEach((n, i) => {
      if (n === i + 1) return;
      for (const o of mine.filter((x) => (x.trip || 1) === n)) {
        o.trip = i + 1;
        moves.push({ id: o.id, truckId: t.id, trip: o.trip, seq: o.seq });
      }
    });
  }
  for (const o of S.orders) if (!o.truckId && o.trip !== 1) { o.trip = 1; moves.push({ id: o.id, truckId: null, trip: 1, seq: o.seq }); }
  return moves;
}

// Nearest-neighbour + 2-opt on straight-line distance. Good enough for a handful of stops.
function hav(a, b) {
  const R = 3958.8, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
async function optimizeTrip(truckId, tripN) {
  const orders = S.orders.filter((o) => o.truckId === truckId && (o.trip || 1) === tripN).sort(bySeq);
  const geo = orders.filter(hasGeo);
  const rest = orders.filter((o) => !hasGeo(o));
  if (geo.length < 2) return toast('Need at least 2 located stops to re-order');
  const yard = yardGeo();
  const start = yard || geo[0];
  const left = [...geo];
  const tour = [];
  let cur = start;
  if (!yard) { tour.push(left.shift()); cur = tour[0]; }
  while (left.length) {
    let bi = 0;
    for (let i = 1; i < left.length; i++) if (hav(cur, left[i]) < hav(cur, left[bi])) bi = i;
    cur = left.splice(bi, 1)[0];
    tour.push(cur);
  }
  const len = (arr) => {
    const p = yard ? [yard, ...arr, yard] : arr;
    let d = 0; for (let i = 1; i < p.length; i++) d += hav(p[i - 1], p[i]); return d;
  };
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = yard ? 0 : 1; i < tour.length - 1; i++) {
      for (let k = i + 1; k < tour.length; k++) {
        const cand = [...tour.slice(0, i), ...tour.slice(i, k + 1).reverse(), ...tour.slice(k + 1)];
        if (len(cand) + 1e-9 < len(tour)) { tour.splice(0, tour.length, ...cand); improved = true; }
      }
    }
  }
  const final = [...tour, ...rest];
  const moves = final.map((o, i) => { o.seq = i; return { id: o.id, truckId, trip: tripN, seq: i }; });
  render();
  try { await api('orders/move', { method: 'POST', body: { moves } }); toast('Stops re-ordered'); }
  catch (e) { toast(e.message, true); refresh(); }
}

// ---------------------------------------------------------------- map
let map, layer, markers = new Map(), pickCallback = null, fitDone = false;

function initMap() {
  map = L.map('map', { zoomControl: true }).setView([41.85, -71.95], 10); // NE Connecticut until a yard is set
  L.tileLayer(S.config.tileUrl, { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  layer = L.layerGroup().addTo(map);
  map.on('click', (e) => {
    if (!pickCallback) return;
    const cb = pickCallback;
    endPick();
    cb(e.latlng);
  });
  $('#cancelPick').onclick = () => { const cb = pickCallback; endPick(); cb?.(null); };
}

function startPick(cb) {
  pickCallback = cb;
  $('#mapHint').classList.remove('hidden');
  map.getContainer().style.cursor = 'crosshair';
}
function endPick() {
  pickCallback = null;
  $('#mapHint').classList.add('hidden');
  map.getContainer().style.cursor = '';
}

function pinIcon(label, color, warn) {
  const w = String(label).length > 1 ? 34 : 24;
  return L.divIcon({ className: '', iconSize: [w, 24], iconAnchor: [w / 2, 12], popupAnchor: [0, -12],
    html: `<div class="pin${warn ? ' warnPin' : ''}" style="background:${color}">${esc(label)}</div>` });
}

function renderMap(fit = false) {
  if (!map) return;
  layer.clearLayers();
  markers = new Map();
  const bounds = [];
  const yard = yardGeo();
  if (yard) {
    L.marker([yard.lat, yard.lng], { icon: L.divIcon({ className: '', iconSize: [28, 28], iconAnchor: [14, 14], html: '<div class="pin yardPin">Y</div>' }), zIndexOffset: 1000 })
      .bindPopup(`<b>Yard</b><br>${esc(S.settings.yard.address || '')}`).addTo(layer);
  }
  const legend = [];
  for (const col of buildColumns()) {
    const key = col.truck ? col.truck.id : '_u';
    const color = col.truck ? col.truck.color : UNASSIGNED_COLOR;
    const count = col.trips.reduce((s, t) => s + t.orders.length, 0);
    if (count) legend.push({ key, color, name: col.truck ? col.truck.name : 'Unassigned', count });
    if (S.hidden.has(key)) continue;
    const dim = S.focusTruck && S.focusTruck !== key;
    for (const trip of col.trips) {
      trip.orders.forEach((o, i) => {
        if (!hasGeo(o)) return;
        const label = !col.truck ? '•' : trip.n > 1 ? `${trip.n}·${i + 1}` : String(i + 1);
        const warn = orderWarnings(o, col.truck).some((w) => !w.soft);
        const m = L.marker([o.lat, o.lng], { icon: pinIcon(label, color, warn), opacity: dim ? 0.35 : 1, zIndexOffset: dim ? -500 : 0 })
          .bindPopup(popupHtml(o, col.truck, trip.n, i + 1))
          .addTo(layer);
        m.on('popupopen', (e) => {
          const b = e.popup.getElement().querySelector('[data-edit]');
          if (b) b.onclick = () => openOrder(o.id);
        });
        markers.set(o.id, m);
        if (!S.focusTruck || S.focusTruck === key) bounds.push([o.lat, o.lng]);
      });
      if (col.truck) drawRoute(trip, color, dim);
    }
  }
  if (yard && bounds.length) bounds.push([yard.lat, yard.lng]);

  $('#mapLegend').innerHTML = legend.length > 1 || legend.some((l) => l.key !== '_u')
    ? legend.map((l) => `<div data-key="${l.key}" class="${S.hidden.has(l.key) ? 'dim' : ''}"><i style="background:${l.color}"></i>${esc(l.name)} <span class="muted">(${l.count})</span></div>`).join('')
    : '';
  $$('#mapLegend [data-key]').forEach((d) => d.onclick = () => {
    const k = d.dataset.key; S.hidden.has(k) ? S.hidden.delete(k) : S.hidden.add(k); renderMap();
  });

  if ((fit || !fitDone) && bounds.length) {
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    fitDone = true;
  } else if (!fitDone && yard) {
    map.setView([yard.lat, yard.lng], 11);
  }
}

function popupHtml(o, truck, tripN, stopNo) {
  const warns = orderWarnings(o, truck);
  return `<b>${esc(o.customer || 'Untitled')}</b>${o.orderNo ? ` <span class="muted">#${esc(o.orderNo)}</span>` : ''}<br>
    ${esc(o.address || '')}<br>
    <span class="muted">${truck ? `${esc(truck.name)} · trip ${tripN} · stop ${stopNo}` : 'Unassigned'}</span><br>
    ${o.weight != null ? fmtLb(o.weight) : 'Weight not set'}${o.length != null ? ` · ${o.length}'` : ''}
    ${o.windowStart || o.windowEnd ? ` · ${fmtTime(o.windowStart)}–${fmtTime(o.windowEnd)}` : ''}
    ${warns.filter((w) => !w.soft).map((w) => `<div style="color:var(--danger);font-weight:600">${esc(w.text)}</div>`).join('')}
    <div style="margin-top:6px"><button class="btn small" data-edit>Edit order</button></div>`;
}

function drawRoute(trip, color, dim) {
  const pts = tripPoints(trip);
  if (pts.length < 2) return;
  const key = routeKey(pts);
  const rt = S.routes.get(key);
  const style = { color, weight: dim ? 3 : 5, opacity: dim ? 0.25 : 0.8 };
  if (rt && typeof rt === 'object') {
    L.polyline(rt.line, style).addTo(layer);
  } else {
    // straight dashed line until (or if) the real route comes back
    L.polyline(pts.map((p) => [p.lat, p.lng]), { ...style, dashArray: '6 8', weight: 3 }).addTo(layer);
    if (!rt) fetchRoute(key, pts);
  }
}

let routeQueue = Promise.resolve();
function fetchRoute(key, pts) {
  S.routes.set(key, 'pending');
  routeQueue = routeQueue.then(async () => {
    try {
      const r = await api('route', { method: 'POST', body: { points: pts.map(({ lat, lng }) => ({ lat, lng })) } });
      S.routes.set(key, r);
    } catch {
      S.routes.set(key, 'fail');
      return;
    }
    if (!S.dragging) { renderBoard(); renderMap(); }
  });
}

// ---------------------------------------------------------------- order dialog
const orderDlg = $('#orderDialog');
const orderForm = $('#orderForm');
let editingId = null;

function openOrder(id) {
  editingId = id;
  const o = id ? S.orders.find((x) => x.id === id) : { date: S.date, status: 'open', truckId: null };
  orderForm.reset();
  $('#orderTitle').textContent = id ? `Edit order — ${o.customer || ''}` : 'New order';
  $('#deleteOrder').classList.toggle('hidden', !id);
  $('#orderTruckSel').innerHTML = '<option value="">Unassigned</option>' +
    S.trucks.map((t) => `<option value="${t.id}">${esc(t.name)}${t.active ? '' : ' (off board)'}</option>`).join('');
  const f = orderForm.elements;
  for (const k of ['customer', 'orderNo', 'phone', 'date', 'address', 'weight', 'length', 'windowStart', 'windowEnd', 'materials', 'notes', 'status']) {
    f.namedItem(k).value = o[k] ?? '';
  }
  f.truckId.value = o.truckId || '';
  f.needsBoom.checked = !!o.needsBoom;
  f.needsForklift.checked = !!o.needsForklift;
  f.lat.value = o.lat ?? '';
  f.lng.value = o.lng ?? '';
  $('#geoResults').innerHTML = '';
  setGeoStatus('#geoStatus', hasGeo(o) ? 'ok' : '', hasGeo(o) ? '📍 Located on map' : o.address ? 'Not located yet — press Find' : '');
  orderDlg.showModal();
  if (!id) f.customer.focus();
}

function setGeoStatus(sel, cls, text) {
  const el = $(sel);
  el.className = 'geoStatus ' + cls;
  el.textContent = text;
}

async function geocodeInto({ input, results, status, latEl, lngEl, autoPick = false }) {
  const q = input.value.trim();
  if (q.length < 3) return setGeoStatus(status, 'bad', 'Type an address first');
  setGeoStatus(status, '', 'Searching…');
  $(results).innerHTML = '';
  try {
    const list = await api('geocode?q=' + encodeURIComponent(q));
    if (!list.length) return setGeoStatus(status, 'bad', 'No match. Try adding the town and state, or use Pin on map.'), false;
    const pick = (r) => {
      latEl.value = r.lat; lngEl.value = r.lng;
      $(results).innerHTML = '';
      setGeoStatus(status, 'ok', '📍 ' + r.label);
    };
    if (autoPick || list.length === 1) { pick(list[0]); return true; }
    setGeoStatus(status, '', 'Pick the right match:');
    $(results).innerHTML = list.map((r, i) => `<button type="button" data-i="${i}">${esc(r.label)}</button>`).join('');
    $$(results + ' button').forEach((b) => b.onclick = () => pick(list[b.dataset.i]));
    return true;
  } catch (e) {
    setGeoStatus(status, 'bad', e.message);
    return false;
  }
}

const orderGeo = () => ({ input: $('#addrInput'), results: '#geoResults', status: '#geoStatus', latEl: orderForm.elements.lat, lngEl: orderForm.elements.lng });
$('#addrSearch').onclick = () => geocodeInto(orderGeo());
$('#addrInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); geocodeInto(orderGeo()); } });
$('#addrInput').addEventListener('input', () => {
  orderForm.elements.lat.value = ''; orderForm.elements.lng.value = '';
  setGeoStatus('#geoStatus', '', 'Not located yet — press Find');
});
$('#addrPick').onclick = () => {
  orderDlg.close();
  startPick((ll) => {
    if (ll) {
      orderForm.elements.lat.value = ll.lat.toFixed(6);
      orderForm.elements.lng.value = ll.lng.toFixed(6);
      setGeoStatus('#geoStatus', 'ok', `📍 Pinned at ${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`);
      if (!$('#addrInput').value) $('#addrInput').value = `Pinned ${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`;
    }
    orderDlg.showModal();
  });
};

orderForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = orderForm.elements;
  if (f.address.value.trim() && !f.lat.value) await geocodeInto({ ...orderGeo(), autoPick: true });
  const body = {
    customer: f.customer.value, orderNo: f.orderNo.value, phone: f.phone.value, date: f.date.value,
    address: f.address.value, lat: f.lat.value, lng: f.lng.value,
    weight: f.weight.value, length: f.namedItem('length').value, windowStart: f.windowStart.value, windowEnd: f.windowEnd.value,
    needsBoom: f.needsBoom.checked, needsForklift: f.needsForklift.checked,
    materials: f.materials.value, notes: f.notes.value, status: f.status.value,
    truckId: f.truckId.value || null,
  };
  const prev = editingId ? S.orders.find((x) => x.id === editingId) : null;
  if (!prev || prev.truckId !== body.truckId) {
    // landing on a truck: append to its last trip
    const mine = S.orders.filter((o) => o.truckId === body.truckId && o.id !== editingId);
    body.trip = body.truckId ? Math.max(1, ...mine.map((o) => o.trip || 1)) : 1;
    body.seq = mine.filter((o) => (o.trip || 1) === body.trip).length;
  }
  try {
    if (editingId) await api('orders/' + editingId, { method: 'PUT', body });
    else await api('orders', { method: 'POST', body });
    orderDlg.close();
    if (body.date !== S.date) toast(`Saved to ${niceDate(body.date)}`);
    else toast('Order saved');
    await refresh(true);
    if (f.lat.value && body.date === S.date) {
      const saved = editingId || S.orders.at(-1)?.id;
      if (saved) selectOrder(saved, true);
    }
  } catch (err) { toast(err.message, true); }
});

$('#deleteOrder').onclick = async () => {
  if (!editingId || !confirm('Delete this order?')) return;
  try { await api('orders/' + editingId, { method: 'DELETE' }); orderDlg.close(); toast('Order deleted'); refresh(true); }
  catch (e) { toast(e.message, true); }
};

// ---------------------------------------------------------------- trucks dialog
const trucksDlg = $('#trucksDialog');
const PALETTE = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#be185d', '#4d7c0f', '#7c3aed', '#b45309'];

function openTrucks() { renderTruckRows(); trucksDlg.showModal(); }

function renderTruckRows() {
  const types = S.config.truckTypes || [];
  $('#truckRows').innerHTML = S.trucks.map((t) => `
    <tr data-id="${t.id}">
      <td><input type="color" data-k="color" value="${t.color}"></td>
      <td><input data-k="name" value="${esc(t.name)}"></td>
      <td><select data-k="type">${types.map((x) => `<option ${x === t.type ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></td>
      <td><input data-k="driver" value="${esc(t.driver || '')}" placeholder="—"></td>
      <td><input type="number" data-k="maxWeight" min="0" step="100" value="${t.maxWeight ?? ''}"></td>
      <td><input type="number" data-k="maxLength" min="0" step="1" value="${t.maxLength ?? ''}"></td>
      <td class="c"><input type="checkbox" data-k="hasBoom" ${t.hasBoom ? 'checked' : ''}></td>
      <td class="c"><input type="checkbox" data-k="hasForklift" ${t.hasForklift ? 'checked' : ''}></td>
      <td class="c"><input type="checkbox" data-k="active" ${t.active ? 'checked' : ''}></td>
      <td><button class="btn icon danger" data-del title="Remove truck">✕</button></td>
    </tr>`).join('') || '<tr><td colspan="10" class="muted" style="padding:14px 4px">No trucks yet. Add one below.</td></tr>';

  $$('#truckRows tr[data-id]').forEach((tr) => {
    const tid = tr.dataset.id;
    $$('[data-k]', tr).forEach((inp) => inp.addEventListener('change', async () => {
      const k = inp.dataset.k;
      const v = inp.type === 'checkbox' ? inp.checked : inp.value;
      // sensible defaults when switching type
      const patch = { [k]: v };
      if (k === 'type' && v === 'Boom truck') { patch.hasBoom = true; $('[data-k=hasBoom]', tr).checked = true; }
      if (k === 'type' && v === 'Flatbed + Moffett') { patch.hasForklift = true; $('[data-k=hasForklift]', tr).checked = true; }
      try {
        const saved = await api('trucks/' + tid, { method: 'PUT', body: patch });
        Object.assign(truckById(tid), saved);
        render();
      } catch (e) { toast(e.message, true); }
    }));
    $('[data-del]', tr).onclick = async () => {
      const n = S.orders.filter((o) => o.truckId === tid).length;
      if (!confirm(`Remove ${truckById(tid).name}?${n ? ` Its ${n} order(s) today go back to Unassigned.` : ''}`)) return;
      await api('trucks/' + tid, { method: 'DELETE' });
      await refresh(true);
      renderTruckRows();
    };
  });
}

$('#addTruck').onclick = async () => {
  const n = S.trucks.length;
  try {
    const t = await api('trucks', { method: 'POST', body: { name: `Truck ${n + 1}`, type: 'Flatbed', color: PALETTE[n % PALETTE.length], maxWeight: 10000, maxLength: 24, active: true } });
    S.trucks.push(t);
    renderTruckRows();
    render();
    $(`#truckRows tr[data-id="${t.id}"] [data-k=name]`)?.select();
  } catch (e) { toast(e.message, true); }
};

// ---------------------------------------------------------------- settings dialog
const settingsDlg = $('#settingsDialog');
const settingsForm = $('#settingsForm');
function openSettings() {
  const f = settingsForm.elements;
  f.companyName.value = S.settings.companyName || '';
  f.yardAddress.value = S.settings.yard?.address || '';
  f.yardLat.value = S.settings.yard?.lat ?? '';
  f.yardLng.value = S.settings.yard?.lng ?? '';
  $('#yardResults').innerHTML = '';
  setGeoStatus('#yardStatus', yardGeo() ? 'ok' : '', yardGeo() ? '📍 Yard is on the map' : 'Set the yard so routes start and end there');
  settingsDlg.showModal();
}
const yardGeoArgs = () => ({ input: $('#yardInput'), results: '#yardResults', status: '#yardStatus', latEl: settingsForm.elements.yardLat, lngEl: settingsForm.elements.yardLng });
$('#yardSearch').onclick = () => geocodeInto(yardGeoArgs());
$('#yardInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); geocodeInto(yardGeoArgs()); } });
$('#yardInput').addEventListener('input', () => { settingsForm.elements.yardLat.value = ''; settingsForm.elements.yardLng.value = ''; setGeoStatus('#yardStatus', '', 'Not located yet — press Find'); });
$('#yardPick').onclick = () => {
  settingsDlg.close();
  startPick((ll) => {
    if (ll) {
      settingsForm.elements.yardLat.value = ll.lat.toFixed(6);
      settingsForm.elements.yardLng.value = ll.lng.toFixed(6);
      setGeoStatus('#yardStatus', 'ok', `📍 Pinned at ${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`);
    }
    settingsDlg.showModal();
  });
};
settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = settingsForm.elements;
  if (f.yardAddress.value.trim() && !f.yardLat.value) await geocodeInto({ ...yardGeoArgs(), autoPick: true });
  try {
    S.settings = await api('settings', { method: 'PUT', body: { companyName: f.companyName.value, yard: { address: f.yardAddress.value, lat: f.yardLat.value, lng: f.yardLng.value } } });
    settingsDlg.close();
    S.routes.clear();
    fitDone = false;
    render();
    toast('Settings saved');
  } catch (err) { toast(err.message, true); }
});

$('#rollOver').onclick = async () => {
  const left = S.orders.filter((o) => o.status !== 'delivered');
  if (!left.length) return toast('Nothing undelivered on this day');
  const next = shiftDate(S.date, 1);
  if (!confirm(`Move ${left.length} undelivered order(s) to ${niceDate(next)}? They'll land in Unassigned.`)) return;
  for (const o of left) await api('orders/' + o.id, { method: 'PUT', body: { date: next, truckId: null, trip: 1, status: 'open' } });
  settingsDlg.close();
  toast(`Moved ${left.length} order(s) to ${niceDate(next)}`);
  refresh(true);
};

$('#importFile').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!confirm('Replace ALL current trucks, orders and settings with this backup?')) return;
  try {
    await api('import', { method: 'POST', body: JSON.parse(await file.text()) });
    settingsDlg.close();
    toast('Backup restored');
    refresh(true);
  } catch (err) { toast('Restore failed: ' + err.message, true); }
};

// ---------------------------------------------------------------- run sheet
function printRunSheet(truckId) {
  const truck = truckById(truckId);
  const col = buildColumns().find((c) => c.truck?.id === truckId);
  if (!col || !col.trips.length) return toast(`${truck.name} has no stops on this day`);
  const yard = S.settings.yard?.address;
  const tripsHtml = col.trips.map((trip) => {
    const load = tripLoad(trip, truck);
    const pts = tripPoints(trip);
    const rt = pts.length >= 2 ? S.routes.get(routeKey(pts)) : null;
    const rows = trip.orders.map((o, i) => `
      <tr>
        <td class="n">${i + 1}</td>
        <td><b>${esc(o.customer)}</b>${o.orderNo ? `<br><small>#${esc(o.orderNo)}</small>` : ''}${o.phone ? `<br><small>${esc(o.phone)}</small>` : ''}</td>
        <td>${esc(o.address)}${o.windowStart || o.windowEnd ? `<br><b>Window: ${fmtTime(o.windowStart)}–${fmtTime(o.windowEnd)}</b>` : ''}</td>
        <td>${esc(o.materials || '')}${o.notes ? `<div class="note">${esc(o.notes)}</div>` : ''}</td>
        <td class="r">${o.weight != null ? fmtLb(o.weight) : ''}${o.length != null ? `<br>${o.length}'` : ''}${o.needsBoom ? '<br><b>BOOM</b>' : ''}${o.needsForklift ? '<br><b>MOFFETT</b>' : ''}</td>
        <td class="sig"></td>
      </tr>`).join('');
    return `<h2>Trip ${trip.n} <small>${fmtLb(load.weight)}${truck.maxWeight ? ` of ${fmtLb(truck.maxWeight)}` : ''}${rt && typeof rt === 'object' ? ` · ${rt.distanceMiles.toFixed(0)} mi · ${fmtMin(rt.durationMin)} driving` : ''}</small></h2>
      <table><thead><tr><th>#</th><th>Customer</th><th>Address</th><th>Materials / notes</th><th>Load</th><th>Signed / time</th></tr></thead><tbody>${rows}</tbody></table>`;
  }).join('');
  const w = window.open('', '_blank');
  if (!w) return toast('Allow pop-ups to print run sheets', true);
  w.document.write(`<!doctype html><html><head><title>${esc(truck.name)} — ${S.date}</title><style>
    body{font:12px/1.35 system-ui,Arial,sans-serif;margin:24px;color:#111}
    h1{margin:0;font-size:20px} .hdr{display:flex;justify-content:space-between;border-bottom:3px solid #111;padding-bottom:6px;margin-bottom:10px}
    h2{font-size:15px;margin:16px 0 6px} h2 small{font-weight:400;color:#444}
    table{width:100%;border-collapse:collapse} th,td{border:1px solid #999;padding:5px;vertical-align:top;text-align:left}
    th{background:#eee;font-size:11px;text-transform:uppercase} td.n{font-weight:700;font-size:15px;text-align:center;width:24px}
    td.r{white-space:nowrap} td.sig{width:110px} .note{margin-top:4px;font-style:italic} small{color:#444}
    @media print{body{margin:10mm}}</style></head><body>
    <div class="hdr"><div><h1>${esc(truck.name)} — run sheet</h1>${esc(S.settings.companyName || '')}</div>
    <div style="text-align:right"><b>${niceDate(S.date)}</b><br>Driver: ${esc(truck.driver || '________________')}${yard ? `<br>From: ${esc(yard)}` : ''}</div></div>
    ${tripsHtml}
    <script>window.onload=()=>window.print()<\/script></body></html>`);
  w.document.close();
}

// ---------------------------------------------------------------- data loading
async function refresh(force = false) {
  try {
    const data = await api('state?date=' + S.date);
    const hash = JSON.stringify(data);
    if (!force && hash === S.lastHash) return;
    S.lastHash = hash;
    S.settings = data.settings;
    S.trucks = data.trucks;
    S.orders = data.orders;
    render();
  } catch (e) { toast('Could not reach the server: ' + e.message, true); }
}

function setDate(d) {
  S.date = d;
  $('#dateInput').value = d;
  S.selected = null;
  fitDone = false;
  S.lastHash = '';
  refresh(true);
}

// ---------------------------------------------------------------- wiring
$('#dateInput').onchange = (e) => e.target.value && setDate(e.target.value);
$('#prevDay').onclick = () => setDate(shiftDate(S.date, -1));
$('#nextDay').onclick = () => setDate(shiftDate(S.date, 1));
$('#todayBtn').onclick = () => setDate(todayStr());
$('#newOrderBtn').onclick = () => openOrder(null);
$('#trucksBtn').onclick = openTrucks;
$('#settingsBtn').onclick = openSettings;
$$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
trucksDlg.addEventListener('close', () => refresh(true));

// resizable split between board and map
(() => {
  const sp = $('#splitter');
  try { const w = localStorage.getItem('boardW'); if (w) document.documentElement.style.setProperty('--boardW', w); } catch {}
  sp.addEventListener('mousedown', (e) => {
    e.preventDefault();
    sp.classList.add('drag');
    const move = (ev) => {
      const pct = Math.min(85, Math.max(25, (ev.clientX / window.innerWidth) * 100));
      document.documentElement.style.setProperty('--boardW', pct + '%');
    };
    const up = () => {
      sp.classList.remove('drag');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      map.invalidateSize();
      try { localStorage.setItem('boardW', getComputedStyle(document.documentElement).getPropertyValue('--boardW').trim()); } catch {}
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
})();

// keep a second screen in sync without stepping on edits in progress
setInterval(() => {
  if (document.hidden || S.dragging || $('dialog[open]') || pickCallback) return;
  refresh();
}, 20000);

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, dialog')) return;
  if (e.key === 'n') { e.preventDefault(); openOrder(null); }
  if (e.key === 'ArrowLeft' && e.altKey) setDate(shiftDate(S.date, -1));
  if (e.key === 'ArrowRight' && e.altKey) setDate(shiftDate(S.date, 1));
  if (e.key === 'Enter' && S.selected) openOrder(S.selected);
  if (e.key === 'Escape') { S.focusTruck = null; S.selected = null; renderBoard(); renderMap(true); }
});

(async function init() {
  try { S.config = await api('config'); } catch {}
  $('#dateInput').value = S.date;
  initMap();
  await refresh(true);
})();
})();
