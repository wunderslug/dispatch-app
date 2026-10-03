/* Dispatch board — front end. Plain JS, no build step. Uses Shared (shared.js) for translation + planning. */
(() => {
'use strict';

// ================================================================ state
const S = {
  date: todayStr(),
  settings: { companyName: '', yard: {} },
  trucks: [],
  orders: [],
  lingo: [],
  config: { tileUrl: '', truckTypes: [] },
  selected: null,
  focusTruck: null,
  hidden: new Set(),
  routes: new Map(),
  dragging: null,
  lastHash: '',
  drafts: [],            // orders being reviewed in the import dialog
};
const refreshers = new Set(); // open editors that re-render when the translator changes

// ================================================================ helpers
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

function todayStr(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
function shiftDate(str, days) { const [y, m, d] = str.split('-').map(Number); return todayStr(new Date(y, m - 1, d + days)); }
function niceDate(str) { const [y, m, d] = str.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }); }
function fmtTime(t) { if (!t) return ''; const [hh, mm] = t.split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')}${hh < 12 ? 'a' : 'p'}`; }
function fmtMin(min) { if (min == null) return ''; const m = Math.round(min); return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; }
const town = (addr) => { const p = String(addr || '').split(',').map((s) => s.trim()).filter(Boolean); return p.length > 1 ? p[1] : p[0] || ''; };

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
  toastTimer = setTimeout(() => (t.className = 'toast' + (bad ? ' bad' : '')), 3000);
}

const ICON = {
  ticket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
  print: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v7H6z"/></svg>',
  sort: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
};

// ================================================================ trucks: colour + shape identity (UI kit)
const PALETTE = [
  ['Sage', '#7CA08A'], ['Clay', '#C0735A'], ['Ochre', '#D4A74F'], ['Olive', '#8A9A5B'], ['Terracotta', '#B85C45'], ['Sand', '#CBB08A'],
  ['Slate Blue', '#6F8FB3'], ['Rust', '#A0523A'], ['Pine', '#3F6B57'], ['Mauve', '#8B6F9B'], ['Steel', '#7B8A8E'], ['Stone', '#9C8F7A'],
];
const SHAPES = [
  '<circle cx="6" cy="6" r="5"/>',
  '<rect x="1.5" y="1.5" width="9" height="9" rx="1"/>',
  '<path d="M6 1 11 11H1z"/>',
  '<path d="M6 0.5 11.5 6 6 11.5 0.5 6z"/>',
  '<path d="M1 2h10v2H1zM1 5h10v2H1zM1 8h10v2H1z"/>',
];
const UNASSIGNED_COLOR = '#6B6258';
const sortedTrucks = () => [...S.trucks].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
const truckById = (id) => S.trucks.find((t) => t.id === id);
const truckIndex = (t) => sortedTrucks().findIndex((x) => x.id === t.id);
const truckColor = (id) => truckById(id)?.color || UNASSIGNED_COLOR;
const truckCode = (t) => t.code || `T${String(truckIndex(t) + 1).padStart(2, '0')}`;
const shapeSvg = (t) => `<svg viewBox="0 0 12 12">${SHAPES[Math.max(0, truckIndex(t)) % SHAPES.length]}</svg>`;
const badge = (t) => t ? `<span class="badge" style="--tc:${t.color}"><span class="shape">${shapeSvg(t)}</span>${esc(truckCode(t))}</span>` : '<span class="badge none">—</span>';
const initials = (n) => String(n || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
const driverChip = (t) => t.driver ? `<span class="chip"><span class="av" style="background:${t.color}">${esc(initials(t.driver))}</span>${esc(t.driver)}</span>` : '<span class="chip muted">No driver</span>';

// ================================================================ derived order data
const reqOf = (o) => Shared.orderRequirements(o, S.lingo);
const hasGeo = Shared.hasGeo;
const yardGeo = () => (hasGeo(S.settings.yard) ? S.settings.yard : null);
const bySeq = (a, b) => (a.seq ?? 0) - (b.seq ?? 0) || (a.createdAt || '').localeCompare(b.createdAt || '');
const isAssigned = (o) => o.truckId && truckById(o.truckId);

function orderIssues(o, truck) {
  const req = reqOf(o);
  const hard = truck ? Shared.truckProblems(truck, req) : [];
  const soft = [];
  if (req.unknown.length) soft.push({ kind: 'unknown', text: `${req.unknown.length} item${req.unknown.length > 1 ? 's' : ''} not translated yet` });
  if (!o.address) soft.push({ kind: 'geo', text: 'No delivery address' });
  else if (!hasGeo(o)) soft.push({ kind: 'geo', text: 'Address not found on map yet' });
  return { req, hard, soft };
}

function statusPill(o, issues) {
  if (o.status === 'delivered') return '<span class="pill done">Delivered</span>';
  if (o.status === 'loaded') return '<span class="pill transit">Loaded</span>';
  if (issues.hard.length) return '<span class="pill problem">Problem</span>';
  if (!isAssigned(o)) return '<span class="pill unassigned">Unassigned</span>';
  if (o.assign === 'proposed') return '<span class="pill proposed">Proposed</span>';
  return '<span class="pill confirmed">Confirmed</span>';
}

function needTags(req) {
  return [
    req.lengthFt != null ? `<span class="tag">${req.lengthFt}'</span>` : '',
    req.boom ? '<span class="tag boom">Boom</span>' : '',
    req.moffett ? '<span class="tag fork">Moffett</span>' : '',
    req.covered ? '<span class="tag cov">Covered</span>' : '',
  ].join('');
}

function buildColumns() {
  const cols = [{ truck: null, trips: [{ n: 1, orders: S.orders.filter((o) => !isAssigned(o)).sort((a, b) => (a.priority === 'rush' ? -1 : 0) - (b.priority === 'rush' ? -1 : 0) || bySeq(a, b)) }] }];
  for (const t of sortedTrucks()) {
    const mine = S.orders.filter((o) => o.truckId === t.id);
    if (!t.active && !mine.length) continue;
    const nos = [...new Set(mine.map((o) => o.trip || 1))].sort((a, b) => a - b);
    cols.push({ truck: t, trips: nos.map((n) => ({ n, orders: mine.filter((o) => (o.trip || 1) === n).sort(bySeq) })) });
  }
  return cols;
}

function tripPoints(trip) {
  const yard = yardGeo();
  const pts = trip.orders.filter(hasGeo).map((o) => ({ lat: o.lat, lng: o.lng }));
  if (yard) { pts.unshift({ lat: yard.lat, lng: yard.lng }); pts.push({ lat: yard.lat, lng: yard.lng }); }
  return pts;
}
const routeKey = (pts) => pts.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(';');

function unknownLines(orders) {
  const map = new Map();
  for (const o of orders) {
    for (const line of reqOf(o).unknown) {
      const key = (line.sku || '').toUpperCase() + '|' + (line.sku ? '' : (line.desc || '').toUpperCase());
      if (!map.has(key)) map.set(key, { line, count: 0, orders: new Set() });
      const e = map.get(key); e.count++; e.orders.add(o.customer || o.orderNo || 'order');
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

// ================================================================ render: top + plan bar
function render() {
  renderStats();
  renderPlanBar();
  renderBoard();
  renderMap();
}

function renderStats() {
  $('#companyName').textContent = S.settings.companyName || 'Dispatch';
  document.title = `Dispatch — ${niceDate(S.date)}`;
  const total = S.orders.length;
  const unassigned = S.orders.filter((o) => !isAssigned(o)).length;
  const rush = S.orders.filter((o) => o.priority === 'rush' && o.status !== 'delivered').length;
  const delivered = S.orders.filter((o) => o.status === 'delivered').length;
  let problems = 0;
  for (const o of S.orders) if (isAssigned(o)) problems += Shared.truckProblems(truckById(o.truckId), reqOf(o)).length ? 1 : 0;
  const todo = unknownLines(S.orders).length;
  $('#dayStats').innerHTML = `
    <span><b>${total}</b> orders</span>
    <span class="${unassigned ? 'warnc' : ''}"><b>${unassigned}</b> unassigned</span>
    ${rush ? `<span class="warnc"><b>${rush}</b> rush</span>` : ''}
    <span><b>${delivered}</b> delivered</span>
    ${problems ? `<span class="bad"><b>${problems}</b> problem${problems > 1 ? 's' : ''}</span>` : ''}`;
  const c = $('#lingoCount');
  c.textContent = todo;
  c.classList.toggle('hidden', !todo);
}

function renderPlanBar() {
  const bar = $('#planBar');
  const prop = S.orders.filter((o) => o.assign === 'proposed' && isAssigned(o));
  const stuck = S.orders.filter((o) => !isAssigned(o) && o.planReason);
  if (!prop.length && !stuck.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  bar.innerHTML = `
    <span class="pill proposed">Plan</span>
    <span>${prop.length ? `<b>${prop.length}</b> load${prop.length > 1 ? 's' : ''} proposed. Check them, drag anything you'd do differently, then accept.` : ''}
      ${stuck.length ? ` <b>${stuck.length}</b> couldn't be placed — see Unassigned.` : ''}</span>
    <span class="spacer"></span>
    ${prop.length ? '<button class="btn small ghost" id="clearPlan">Clear proposals</button><button class="btn small secondary" id="acceptAll">Accept all</button>' : ''}`;
  $('#acceptAll')?.addEventListener('click', () => accept({}));
  $('#clearPlan')?.addEventListener('click', async () => {
    await api('clear-proposals', { method: 'POST', body: { date: S.date } });
    refresh(true);
  });
}

async function accept(body) {
  try {
    const r = await api('accept', { method: 'POST', body: { date: S.date, ...body } });
    toast(`${r.accepted} load${r.accepted === 1 ? '' : 's'} confirmed`);
    refresh(true);
  } catch (e) { toast(e.message, true); }
}

// ================================================================ render: board
function renderBoard() {
  const board = $('#board');
  const scroll = board.scrollLeft;
  const colScroll = Object.fromEntries($$('.col', board).map((c) => [c.dataset.truck, $('.colBody', c)?.scrollTop || 0]));
  board.innerHTML = '';
  for (const col of buildColumns()) board.appendChild(renderColumn(col));
  if (!S.trucks.length) {
    board.appendChild(h(`<div class="col"><div class="colHead"><div class="row1"><span class="name">No trucks yet</span></div>
      <div class="sub">Add your fleet so orders can be assigned.</div></div><div class="colBody"><button class="btn primary" data-first>+ Add trucks</button></div></div>`));
    $('[data-first]', board).onclick = openTrucks;
  }
  board.scrollLeft = scroll;
  for (const c of $$('.col', board)) { const b = $('.colBody', c); if (b) b.scrollTop = colScroll[c.dataset.truck] || 0; }
}

function renderColumn({ truck, trips }) {
  const col = h(`<div class="col${truck && S.focusTruck === truck.id ? ' focus' : ''}"></div>`);
  col.dataset.truck = truck ? truck.id : '';
  col.style.setProperty('--tc', truck ? truck.color : UNASSIGNED_COLOR);
  const count = trips.reduce((s, t) => s + t.orders.length, 0);

  if (truck) {
    const proposed = trips.some((tr) => tr.orders.some((o) => o.assign === 'proposed'));
    const head = h(`<div class="colHead">
      <div class="row1">${badge(truck)}<span class="name" title="Show on map">${esc(truck.name)}</span>
        ${proposed ? `<button class="btn small secondary" data-act="accept" title="Confirm this truck's proposed loads">${ICON.check}Accept</button>` : ''}
        <button class="btn icon ghost" data-act="print" title="Print run sheet">${ICON.print}</button></div>
      <div class="sub">${driverChip(truck)}<span>${count} stop${count === 1 ? '' : 's'}</span>${truck.active ? '' : '<span class="pill low">Off board</span>'}</div>
      <div class="tags">${truck.type ? `<span class="tag">${esc(truck.type)}</span>` : ''}${truck.maxLength ? `<span class="tag">${truck.maxLength}' deck</span>` : ''}${truck.hasBoom ? '<span class="tag boom">Boom</span>' : ''}${truck.hasForklift ? '<span class="tag fork">Moffett</span>' : ''}${truck.covered ? '<span class="tag cov">Covered</span>' : ''}</div>
    </div>`);
    $('.name', head).onclick = () => { S.focusTruck = S.focusTruck === truck.id ? null : truck.id; renderBoard(); renderMap(true); if (S.focusTruck) expandMap(true); };
    $('[data-act=print]', head).onclick = () => printRunSheet(truck.id);
    $('[data-act=accept]', head)?.addEventListener('click', () => accept({ truckId: truck.id }));
    col.appendChild(head);
  } else {
    const head = h(`<div class="colHead"><div class="row1"><span class="name">Unassigned</span><span class="muted">${count}</span>
      <button class="btn small primary" data-act="new">+ Order</button></div>
      <div class="sub">Import tickets, then Auto-plan — or drag onto a truck.</div></div>`);
    $('[data-act=new]', head).onclick = () => openOrder(null);
    col.appendChild(head);
  }

  const body = h('<div class="colBody"></div>');
  if (!truck) body.appendChild(dropZone(trips[0].orders, null, 1, 'Nothing waiting'));
  else {
    for (const trip of trips) body.appendChild(renderTrip(trip, truck));
    const nextN = (trips.at(-1)?.n || 0) + 1;
    const extra = h('<div class="trip"></div>');
    extra.appendChild(dropZone([], truck.id, nextN, trips.length ? '+ Drop here for another trip' : 'Drop orders here'));
    body.appendChild(extra);
  }
  col.appendChild(body);
  return col;
}

function renderTrip(trip, truck) {
  const pts = tripPoints(trip);
  const rt = pts.length >= 2 ? S.routes.get(routeKey(pts)) : null;
  const maxStops = truck.maxStops || null;
  const full = maxStops && trip.orders.length > maxStops;
  const el = h(`<div class="trip${full ? ' full' : ''}">
    <div class="tripHead"><span class="t">Trip ${trip.n}</span>
      <span class="meta">${trip.orders.length}${maxStops ? ` / ${maxStops}` : ''} stops${rt && typeof rt === 'object' ? ` · ${rt.distanceMiles.toFixed(0)} mi · ${fmtMin(rt.durationMin)}` : ''}</span>
      ${trip.orders.length > 1 ? `<button class="btn icon ghost" data-act="opt" title="Re-order stops by shortest drive">${ICON.sort}</button>` : ''}
    </div></div>`);
  $('[data-act=opt]', el)?.addEventListener('click', () => optimizeTrip(truck.id, trip.n));
  const legs = {};
  if (rt && typeof rt === 'object') {
    const off = yardGeo() ? 0 : -1;
    trip.orders.filter(hasGeo).forEach((o, i) => { const leg = rt.legs[i + off]; if (leg) legs[o.id] = leg.durationMin; });
  }
  el.appendChild(dropZone(trip.orders, truck.id, trip.n, 'Drop orders here', legs));
  return el;
}

function dropZone(orders, truckId, tripN, hint, legs = {}) {
  const z = h(`<div class="dropZone${orders.length ? '' : ' empty'}"></div>`);
  z.dataset.truck = truckId || '';
  z.dataset.trip = tripN;
  z.dataset.hint = hint;
  const truck = truckId ? truckById(truckId) : null;
  orders.forEach((o, i) => z.appendChild(renderCard(o, truck, i + 1, legs[o.id])));
  z.addEventListener('dragover', (e) => { if (!S.dragging) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; z.classList.add('over'); });
  z.addEventListener('dragleave', (e) => { if (!z.contains(e.relatedTarget)) z.classList.remove('over'); });
  z.addEventListener('drop', (e) => {
    e.preventDefault();
    z.classList.remove('over');
    const id = S.dragging;
    if (!id) return;
    const cards = $$('.card', z).filter((c) => c.dataset.id !== id);
    let idx = cards.length;
    for (let i = 0; i < cards.length; i++) { const r = cards[i].getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) { idx = i; break; } }
    moveOrder(id, truckId || null, Number(tripN), cards.map((c) => c.dataset.id), idx);
  });
  return z;
}

function renderCard(o, truck, stopNo, legMin) {
  const iss = orderIssues(o, truck);
  const req = iss.req;
  const items = (o.lines || []).filter((l, i) => !req.lines[i]?.ignore).length;
  const win = o.windowStart || o.windowEnd ? `${fmtTime(o.windowStart) || '…'}–${fmtTime(o.windowEnd) || '…'}` : '';
  const c = h(`<div class="card${o.assign === 'proposed' && truck ? ' proposed' : ''}${S.selected === o.id ? ' sel' : ''}${o.status === 'delivered' ? ' delivered' : ''}" draggable="true"></div>`);
  c.dataset.id = o.id;
  c.style.setProperty('--tc', truck ? truck.color : UNASSIGNED_COLOR);
  const unplacedWhy = !truck && o.planReason;
  c.innerHTML = `
    <div class="top">
      ${truck ? `<span class="stop">${stopNo}</span>` : ''}
      <span class="ono">${o.orderNo ? '#' + esc(o.orderNo) : esc(o.customer || 'New order')}</span>
      ${o.priority === 'rush' ? '<span class="pill rush">Rush</span>' : ''}
      ${statusPill(o, iss)}
    </div>
    ${o.orderNo ? `<div class="cust">${esc(o.customer || '—')}</div>` : ''}
    <div class="addr">${o.address ? esc(o.address) : 'No address'}</div>
    <div class="facts">
      <span>${items} item${items === 1 ? '' : 's'}</span>
      ${needTags(req)}
      ${win ? `<span>⏱ ${win}</span>` : ''}
      ${legMin != null ? `<span class="muted">${fmtMin(legMin)} drive</span>` : ''}
      ${(o.imageIds || []).length ? `<button class="tix" title="View ticket" data-tix>${ICON.ticket}</button>` : ''}
    </div>
    ${(o.assign === 'proposed' && truck && o.planReason) ? `<div class="why">${esc(o.planReason)}</div>` : ''}
    ${unplacedWhy ? `<div class="why unplaced">${esc(o.planReason)}</div>` : ''}
    ${iss.hard.length || iss.soft.length ? `<div class="warns">
      ${iss.hard.map((t) => `<div class="warn">${esc(t)}</div>`).join('')}
      ${iss.soft.map((w) => `<div class="warn soft">${esc(w.text)}${w.kind === 'unknown' ? '<button class="btn small" data-teach>Translate</button>' : ''}</div>`).join('')}
    </div>` : ''}`;
  c.title = 'Click to select · double-click to open';
  $('[data-tix]', c)?.addEventListener('click', (e) => { e.stopPropagation(); viewTicket(o.imageIds[0]); });
  $('[data-teach]', c)?.addEventListener('click', (e) => { e.stopPropagation(); const u = req.unknown[0]; openTeach({ line: u }); });
  c.addEventListener('dragstart', (e) => { S.dragging = o.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', o.id); requestAnimationFrame(() => c.classList.add('dragging')); });
  c.addEventListener('dragend', () => { S.dragging = null; c.classList.remove('dragging'); $$('.dropZone.over').forEach((z) => z.classList.remove('over')); });
  c.addEventListener('click', () => selectOrder(o.id));
  c.addEventListener('dblclick', () => openOrder(o.id));
  return c;
}

function selectOrder(id) {
  S.selected = id;
  $$('.card').forEach((c) => c.classList.toggle('sel', c.dataset.id === id));
  const o = S.orders.find((x) => x.id === id);
  if (o && hasGeo(o) && markers.has(id)) { map.setView([o.lat, o.lng], Math.max(map.getZoom(), 12)); markers.get(id).openPopup(); }
}

// ================================================================ moving orders
async function moveOrder(id, truckId, tripN, zoneIds, idx) {
  const o = S.orders.find((x) => x.id === id);
  if (!o) return;
  const ids = [...zoneIds];
  ids.splice(idx, 0, id);
  o.assign = truckId ? 'confirmed' : null; // the dispatcher placed it — that's a decision
  o.planReason = '';
  const moves = ids.map((oid, i) => {
    const ord = S.orders.find((x) => x.id === oid);
    Object.assign(ord, { seq: i, truckId, trip: tripN });
    return { id: oid, truckId, trip: tripN, seq: i, ...(oid === id ? { assign: o.assign, planReason: '' } : {}) };
  });
  moves.push(...compactTrips());
  render();
  try { await api('orders/move', { method: 'POST', body: { moves } }); } catch (e) { toast(e.message, true); refresh(true); }
}

function compactTrips() {
  const moves = [];
  for (const t of S.trucks) {
    const mine = S.orders.filter((o) => o.truckId === t.id);
    const nos = [...new Set(mine.map((o) => o.trip || 1))].sort((a, b) => a - b);
    nos.forEach((n, i) => {
      if (n === i + 1) return;
      for (const o of mine.filter((x) => (x.trip || 1) === n)) { o.trip = i + 1; moves.push({ id: o.id, truckId: t.id, trip: o.trip, seq: o.seq }); }
    });
  }
  for (const o of S.orders) if (!o.truckId && o.trip !== 1) { o.trip = 1; moves.push({ id: o.id, truckId: null, trip: 1, seq: o.seq }); }
  return moves;
}

async function optimizeTrip(truckId, tripN) {
  const orders = S.orders.filter((o) => o.truckId === truckId && (o.trip || 1) === tripN).sort(bySeq);
  if (orders.filter(hasGeo).length < 2) return toast('Need at least 2 located stops to re-order', true);
  let tour = Shared.twoOpt(orders, yardGeo());
  const rush = tour.filter((o) => o.priority === 'rush');
  tour = [...rush, ...tour.filter((o) => o.priority !== 'rush')];
  const moves = tour.map((o, i) => { o.seq = i; return { id: o.id, truckId, trip: tripN, seq: i }; });
  render();
  try { await api('orders/move', { method: 'POST', body: { moves } }); toast('Stops re-ordered for the shortest drive'); } catch (e) { toast(e.message, true); refresh(true); }
}

// ================================================================ auto-plan
$('#planBtn').onclick = async () => {
  const todo = S.orders.filter((o) => o.status !== 'delivered' && o.assign !== 'confirmed');
  if (!S.trucks.some((t) => t.active)) return toast('Add trucks first (Trucks button)', true);
  if (!todo.length) return toast('Everything for this day is already confirmed');
  const btn = $('#planBtn');
  btn.disabled = true; btn.textContent = 'Planning…';
  try {
    const r = await api('plan', { method: 'POST', body: { date: S.date } });
    await refresh(true);
    toast(`Proposed ${r.proposed} load${r.proposed === 1 ? '' : 's'}${r.unplaced ? ` · ${r.unplaced} need your call` : ''}`);
    expandMap(false);
  } catch (e) { toast(e.message, true); }
  btn.disabled = false; btn.textContent = 'Auto-plan day';
};

// ================================================================ corner map
let map, layer, markers = new Map(), pickCallback = null, fitDone = false;

function initMap() {
  map = L.map('map', { zoomControl: true, attributionControl: true }).setView([41.85, -71.95], 10);
  const tiles = S.config.tileUrl || 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
  L.tileLayer(tiles, { maxZoom: 19, subdomains: 'abcd', attribution: '&copy; OpenStreetMap &copy; CARTO' }).addTo(map);
  layer = L.layerGroup().addTo(map);
  map.on('click', (e) => { if (!pickCallback) return; const cb = pickCallback; endPick(); cb(e.latlng); });
  $('#cancelPick').onclick = () => { const cb = pickCallback; endPick(); cb?.(null); };
  $('#mmToggle').onclick = () => expandMap(!$('#miniMap').classList.contains('big'));
  $('.mmBody').addEventListener('click', () => { if (!$('#miniMap').classList.contains('big')) expandMap(true); }, true);
}

function expandMap(big) {
  const mm = $('#miniMap');
  mm.classList.toggle('big', big);
  $('#mmToggle').textContent = big ? 'Close' : 'Expand';
  setTimeout(() => { map.invalidateSize(); renderMap(true); }, 200);
}

function startPick(cb) {
  pickCallback = cb;
  expandMap(true);
  $('#mapHint').classList.remove('hidden');
  map.getContainer().style.cursor = 'crosshair';
}
function endPick() { pickCallback = null; $('#mapHint').classList.add('hidden'); map.getContainer().style.cursor = ''; }

function pinIcon(label, color, warn) {
  const w = String(label).length > 1 ? 34 : 24;
  return L.divIcon({ className: '', iconSize: [w, 24], iconAnchor: [w / 2, 12], popupAnchor: [0, -12], html: `<div class="pin${warn ? ' warnPin' : ''}" style="background:${color}">${esc(label)}</div>` });
}

function renderMap(fit = false) {
  if (!map) return;
  layer.clearLayers();
  markers = new Map();
  const bounds = [];
  const yard = yardGeo();
  if (yard) L.marker([yard.lat, yard.lng], { icon: L.divIcon({ className: '', iconSize: [28, 28], iconAnchor: [14, 14], html: '<div class="pin yardPin">Y</div>' }), zIndexOffset: 1000 }).bindPopup(`<b>Yard</b><br>${esc(S.settings.yard.address || '')}`).addTo(layer);
  const legend = [];
  let stops = 0, miles = 0;
  for (const col of buildColumns()) {
    if (!col.truck) continue;
    const t = col.truck;
    const n = col.trips.reduce((s, tr) => s + tr.orders.length, 0);
    if (!n) continue;
    legend.push(t);
    if (S.hidden.has(t.id)) continue;
    const dim = S.focusTruck && S.focusTruck !== t.id;
    for (const trip of col.trips) {
      trip.orders.forEach((o, i) => {
        if (!hasGeo(o)) return;
        stops++;
        const label = trip.n > 1 ? `${trip.n}·${i + 1}` : String(i + 1);
        const warn = Shared.truckProblems(t, reqOf(o)).length > 0;
        const m = L.marker([o.lat, o.lng], { icon: pinIcon(label, t.color, warn), opacity: dim ? 0.3 : 1, zIndexOffset: dim ? -500 : 0 })
          .bindPopup(`<b>${esc(o.customer || '')}</b> ${o.orderNo ? `#${esc(o.orderNo)}` : ''}<br>${esc(o.address || '')}<br><span style="color:var(--t3)">${esc(t.name)} · trip ${trip.n} · stop ${i + 1}</span><div style="margin-top:6px"><button class="btn small" data-edit>Open order</button></div>`)
          .addTo(layer);
        m.on('popupopen', (e) => { const b = e.popup.getElement().querySelector('[data-edit]'); if (b) b.onclick = () => openOrder(o.id); });
        markers.set(o.id, m);
        if (!S.focusTruck || S.focusTruck === t.id) bounds.push([o.lat, o.lng]);
      });
      const pts = tripPoints(trip);
      if (pts.length >= 2) {
        const key = routeKey(pts);
        const rt = S.routes.get(key);
        const style = { color: t.color, weight: dim ? 3 : 5, opacity: dim ? 0.25 : 0.9 };
        if (rt && typeof rt === 'object') { L.polyline(rt.line, style).addTo(layer); miles += rt.distanceMiles; }
        else { L.polyline(pts.map((p) => [p.lat, p.lng]), { ...style, dashArray: '6 8', weight: 3 }).addTo(layer); if (!rt) fetchRoute(key, pts); }
      }
    }
  }
  if (yard && bounds.length) bounds.push([yard.lat, yard.lng]);
  $('#mmSub').textContent = stops ? `${stops} stops${miles ? ` · ${miles.toFixed(0)} mi` : ''}` : 'Shows once loads are on trucks';
  $('#mapLegend').innerHTML = legend.map((t) => `<div data-key="${t.id}" class="${S.hidden.has(t.id) ? 'dim' : ''}">${badge(t)} ${esc(t.name)}</div>`).join('');
  $$('#mapLegend [data-key]').forEach((d) => d.onclick = () => { const k = d.dataset.key; S.hidden.has(k) ? S.hidden.delete(k) : S.hidden.add(k); renderMap(); });
  if ((fit || !fitDone) && bounds.length) { map.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 }); fitDone = true; }
  else if (!fitDone && yard) map.setView([yard.lat, yard.lng], 10);
}

let routeQueue = Promise.resolve();
function fetchRoute(key, pts) {
  S.routes.set(key, 'pending');
  routeQueue = routeQueue.then(async () => {
    try { S.routes.set(key, await api('route', { method: 'POST', body: { points: pts } })); }
    catch { S.routes.set(key, 'fail'); return; }
    if (!S.dragging) { renderBoard(); renderMap(); }
  });
}

// ================================================================ order editor component
/**
 * Renders an editable order into `host`, writing every change straight into `draft`.
 * Used by the order dialog and by each ticket in the import review.
 */
function orderEditor(host, draft) {
  draft.lines ||= [];
  draft.overrides ||= {};
  const imgs = draft.imageIds || [];
  host.innerHTML = '';
  const root = h(`<div class="oe${imgs.length ? '' : ' noimg'}">
    <div class="oeMain">
      <div class="grid4">
        <label>Order #<input data-f="orderNo"></label>
        <label style="grid-column:span 2">Customer<input data-f="customer"></label>
        <label>Phone<input data-f="phone"></label>
      </div>
      <div class="grid4">
        <label>Delivery date<input type="date" data-f="date"></label>
        <label>Priority<select data-f="priority"><option value="rush">Rush</option><option value="normal">Normal</option><option value="low">Low / flexible</option></select></label>
        <label>Window from<input type="time" data-f="windowStart"></label>
        <label>Window to<input type="time" data-f="windowEnd"></label>
      </div>
      <label>Delivery address
        <div class="addrRow"><input data-f="address" placeholder="Street, town, state"><button type="button" class="btn" data-find>Find</button><button type="button" class="btn" data-pin>Pin on map</button></div>
      </label>
      <div class="geoResults" data-georesults></div>
      <div class="geoStatus" data-geostatus></div>
      <label>Delivery instructions (from the ticket)<textarea rows="2" data-f="instructions"></textarea></label>
      <div class="needs" data-needs></div>
      <div class="ovr">
        <label>Boom<select data-ov="boom"><option value="">Auto</option><option value="yes">Needed</option><option value="no">Not needed</option></select></label>
        <label>Moffett<select data-ov="moffett"><option value="">Auto</option><option value="yes">Needed</option><option value="no">Not needed</option></select></label>
        <label>Covered truck<select data-ov="covered"><option value="">Auto</option><option value="yes">Needed</option><option value="no">Not needed</option></select></label>
        <label>Longest item (ft)<input type="number" min="0" step="0.5" data-ov="lengthFt" placeholder="Auto"></label>
      </div>
      <div class="tableWrap" style="max-height:none">
        <table class="lines"><thead><tr><th>Qty</th><th>UOM</th><th>SKU</th><th>Description</th><th>Ft</th><th>Means</th><th title="Not freight">Skip</th><th></th></tr></thead><tbody data-lines></tbody></table>
      </div>
      <div><button type="button" class="btn small" data-addline>+ Add line</button></div>
      <label>Dispatcher notes<textarea rows="2" data-f="notes" placeholder="Anything the driver should know"></textarea></label>
    </div>
    ${imgs.length ? `<div class="oeSide">${imgs.map((id) => `<a data-img="${id}"><img src="api/tickets/${id}" alt="Ticket" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'pdf',textContent:'Open ticket'}))"></a>`).join('')}<p class="small muted">Click to enlarge</p></div>` : ''}
  </div>`);
  host.appendChild(root);

  for (const el of $$('[data-f]', root)) {
    const k = el.dataset.f;
    el.value = draft[k] ?? (k === 'priority' ? 'normal' : '');
    el.addEventListener('input', () => {
      draft[k] = el.value;
      if (k === 'address') { draft.lat = null; draft.lng = null; geoStatus('', draft.address ? 'Will be located when saved — or press Find' : ''); }
      if (k === 'instructions') renderNeeds();
    });
  }
  const ovSel = (v) => (v === true ? 'yes' : v === false ? 'no' : '');
  for (const el of $$('[data-ov]', root)) {
    const k = el.dataset.ov;
    el.value = k === 'lengthFt' ? (draft.overrides.lengthFt ?? '') : ovSel(draft.overrides[k]);
    el.addEventListener('input', () => {
      draft.overrides[k] = k === 'lengthFt' ? (el.value === '' ? null : Number(el.value)) : el.value === 'yes' ? true : el.value === 'no' ? false : null;
      renderNeeds();
    });
  }
  $$('[data-img]', root).forEach((a) => a.onclick = () => viewTicket(a.dataset.img));

  const geoStatus = (cls, text) => { const s = $('[data-geostatus]', root); s.className = 'geoStatus ' + cls; s.textContent = text; };
  geoStatus(hasGeo(draft) ? 'ok' : '', hasGeo(draft) ? 'Located on map' : draft.address ? 'Will be located when saved — or press Find' : '');
  const addrInput = $('[data-f=address]', root);
  const find = async () => {
    const q = addrInput.value.trim();
    if (q.length < 3) return geoStatus('bad', 'Type an address first');
    geoStatus('', 'Searching…');
    const box = $('[data-georesults]', root);
    box.innerHTML = '';
    try {
      const list = await api('geocode?q=' + encodeURIComponent(q));
      if (!list.length) return geoStatus('bad', 'No match. Add the town and state, or use Pin on map.');
      const pick = (r) => { draft.lat = r.lat; draft.lng = r.lng; box.innerHTML = ''; geoStatus('ok', r.label); };
      if (list.length === 1) return pick(list[0]);
      geoStatus('', 'Pick the right match:');
      list.forEach((r) => { const b = h(`<button type="button">${esc(r.label)}</button>`); b.onclick = () => pick(r); box.appendChild(b); });
    } catch (e) { geoStatus('bad', e.message); }
  };
  $('[data-find]', root).onclick = find;
  addrInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); find(); } });
  $('[data-pin]', root).onclick = () => {
    const dlg = root.closest('dialog');
    dlg?.close();
    startPick((ll) => {
      if (ll) {
        draft.lat = +ll.lat.toFixed(6); draft.lng = +ll.lng.toFixed(6);
        if (!draft.address) { draft.address = `Pinned ${draft.lat}, ${draft.lng}`; addrInput.value = draft.address; }
        geoStatus('ok', `Pinned at ${draft.lat}, ${draft.lng}`);
      }
      expandMap(false);
      dlg?.showModal();
    });
  };

  function renderNeeds() {
    const req = reqOf(draft);
    const why = (k) => req.why[k] ? ` <span class="muted">(${esc(req.why[k])})</span>` : '';
    const parts = [];
    if (req.lengthFt != null) parts.push(`<span class="tag">${req.lengthFt}' deck</span>${req.lengthWhy ? ` <span class="muted">(${esc(req.lengthWhy)})</span>` : ''}`);
    if (req.boom) parts.push(`<span class="tag boom">Boom</span>${why('boom')}`);
    if (req.moffett) parts.push(`<span class="tag fork">Moffett</span>${why('moffett')}`);
    if (req.covered) parts.push(`<span class="tag cov">Covered</span>${why('covered')}`);
    if (req.unknown.length) parts.push(`<span class="pill risk">${req.unknown.length} untranslated</span>`);
    const fits = S.trucks.filter((t) => t.active && !Shared.truckProblems(t, req).length);
    $('[data-needs]', root).innerHTML = `<b>Needs:</b> ${parts.join(' · ') || '<span class="muted">nothing special</span>'}
      <span class="spacer"></span><span class="muted">Fits:</span> ${fits.length ? fits.map(badge).join(' ') : '<span class="pill problem">no truck</span>'}`;
  }

  function renderLines() {
    const tb = $('[data-lines]', root);
    tb.innerHTML = '';
    draft.lines.forEach((line, i) => {
      const ev = Shared.evaluateLine(line, S.lingo);
      const parsed = Shared.parseLength(`${line.sku} ${line.desc}`);
      const tr = h(`<tr class="${ev.ignore ? 'ignored' : !ev.known ? 'unknown' : ''}">
        <td><input class="q" data-k="qty" type="number" step="any"></td>
        <td><input class="u" data-k="uom"></td>
        <td><input class="s" data-k="sku"></td>
        <td><input data-k="desc"></td>
        <td><input class="l" data-k="lengthFt" type="number" step="0.5" placeholder="${parsed ?? ''}"></td>
        <td class="mean">${ev.ignore ? '<span class="muted">not freight</span>' : ev.rule ? `<span class="ok">${esc(ev.meaning || 'translated')}</span>` : ev.known ? `<span class="muted">${ev.lengthFt}' from description</span>` : '<span class="unk">Unknown</span>'}
          ${[ev.boom && '<span class="tag boom">B</span>', ev.moffett && '<span class="tag fork">M</span>', ev.covered && '<span class="tag cov">C</span>'].filter(Boolean).join(' ')}</td>
        <td class="c"><input type="checkbox" data-k="ignore"></td>
        <td style="white-space:nowrap"><button type="button" class="btn small${ev.known ? ' ghost' : ' primary'}" data-teach>${ev.rule ? 'Edit' : 'Teach'}</button><button type="button" class="btn icon ghost" data-del title="Remove line">✕</button></td>
      </tr>`);
      for (const inp of $$('[data-k]', tr)) {
        const k = inp.dataset.k;
        if (inp.type === 'checkbox') inp.checked = !!line[k]; else inp.value = line[k] ?? '';
        inp.addEventListener(inp.type === 'checkbox' ? 'change' : 'input', () => {
          line[k] = inp.type === 'checkbox' ? inp.checked : (inp.type === 'number' ? (inp.value === '' ? null : Number(inp.value)) : inp.value);
          renderNeeds();
          if (inp.type === 'checkbox') renderLines();
        });
        if (inp.type !== 'checkbox') inp.addEventListener('change', renderLines);
      }
      $('[data-teach]', tr).onclick = () => openTeach({ line, rule: ev.rule });
      $('[data-del]', tr).onclick = () => { draft.lines.splice(i, 1); renderLines(); renderNeeds(); };
      tb.appendChild(tr);
    });
    if (!draft.lines.length) tb.appendChild(h('<tr><td colspan="8" class="muted" style="padding:8px">No items yet.</td></tr>'));
  }
  $('[data-addline]', root).onclick = () => { draft.lines.push({ qty: null, uom: '', sku: '', desc: '' }); renderLines(); $$('[data-k=sku]', root).at(-1)?.focus(); };

  renderNeeds();
  renderLines();
  const refresher = () => { if (!root.isConnected) { refreshers.delete(refresher); return; } renderLines(); renderNeeds(); };
  refreshers.add(refresher);
}

// ================================================================ order dialog
const orderDlg = $('#orderDialog');
let editing = null;

function openOrder(id) {
  const o = id ? S.orders.find((x) => x.id === id) : null;
  editing = o ? structuredClone(o) : { date: S.date, priority: 'normal', status: 'open', truckId: null, lines: [], overrides: {}, source: 'manual' };
  $('#orderTitle').textContent = o ? `Order ${o.orderNo ? '#' + o.orderNo : ''} ${o.customer ? '— ' + o.customer : ''}` : 'New order';
  $('#deleteOrder').classList.toggle('hidden', !o);
  $('#orderTruckSel').innerHTML = '<option value="">Unassigned</option>' + sortedTrucks().map((t) => `<option value="${t.id}">${esc(truckCode(t))} · ${esc(t.name)}${t.active ? '' : ' (off board)'}</option>`).join('');
  $('#orderTruckSel').value = editing.truckId || '';
  $('#orderStatus').value = editing.status || 'open';
  $('#orderPlanWhy').textContent = o?.planReason ? (o.assign === 'proposed' ? 'Proposed: ' : '') + o.planReason : '';
  orderEditor($('#orderEditor'), editing);
  orderDlg.showModal();
}

$('#orderForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const d = editing;
  const prev = d.id ? S.orders.find((x) => x.id === d.id) : null;
  const truckId = $('#orderTruckSel').value || null;
  const body = {
    customer: d.customer, orderNo: d.orderNo, phone: d.phone, date: d.date || S.date, priority: d.priority,
    address: d.address, windowStart: d.windowStart, windowEnd: d.windowEnd, instructions: d.instructions, notes: d.notes,
    lines: d.lines, overrides: d.overrides, status: $('#orderStatus').value, truckId,
  };
  if (hasGeo(d)) { body.lat = d.lat; body.lng = d.lng; }
  if (!prev || prev.truckId !== truckId) {
    const mine = S.orders.filter((o) => o.truckId === truckId && o.id !== d.id);
    body.trip = truckId ? Math.max(1, ...mine.map((o) => o.trip || 1)) : 1;
    body.seq = mine.filter((o) => (o.trip || 1) === body.trip).length;
    body.assign = truckId ? 'confirmed' : null;
    body.planReason = '';
  }
  try {
    if (prev) await api('orders/' + d.id, { method: 'PUT', body });
    else await api('orders', { method: 'POST', body: { ...body, source: 'manual' } });
    orderDlg.close();
    toast(body.date !== S.date ? `Saved to ${niceDate(body.date)}` : 'Order saved');
    refresh(true);
  } catch (err) { toast(err.message, true); }
});

$('#deleteOrder').onclick = async () => {
  if (!editing?.id || !confirm('Delete this order?')) return;
  try { await api('orders/' + editing.id, { method: 'DELETE' }); orderDlg.close(); toast('Order deleted'); refresh(true); } catch (e) { toast(e.message, true); }
};

// ================================================================ ticket viewer
function viewTicket(id) {
  const holder = $('#imgHolder');
  holder.innerHTML = `<img src="api/tickets/${id}" alt="Ticket">`;
  $('img', holder).onerror = () => { holder.innerHTML = `<iframe src="api/tickets/${id}"></iframe>`; };
  $('#imgDialog').showModal();
}

// ================================================================ import
const importDlg = $('#importDialog');

function openImport() {
  if (!S.drafts.length) resetImport();
  const s = S.settings;
  $('#readerNote').textContent = s.ticketReader === 'tesseract' || (s.ticketReader === 'auto' && !s.hasApiKey)
    ? 'Tickets are read with local OCR on your server. Check each one before adding it — or set a Claude API key in Settings for better accuracy.'
    : 'Tickets are read with Claude. Check each one before adding it to the board.';
  importDlg.showModal();
}

function resetImport() {
  S.drafts = [];
  $('#importStart').classList.remove('hidden');
  $('#csvMap').classList.add('hidden');
  $('#importProgress').classList.add('hidden');
  $('#importReview').innerHTML = '';
  $('#importFooter').classList.add('hidden');
}

const drop = $('#dropArea');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => readTickets([...e.dataTransfer.files]));
$('#ticketFiles').onchange = (e) => { readTickets([...e.target.files]); e.target.value = ''; };
$('#importMore').onclick = () => { $('#importStart').classList.remove('hidden'); $('#importStart').scrollIntoView({ behavior: 'smooth' }); };

function fileToDataUrl(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}
async function shrinkImage(file) {
  // Phone photos are huge; 2200px on the long side is plenty to read a printed ticket.
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.88);
  } catch { return fileToDataUrl(file); }
}

async function readTickets(files) {
  files = files.filter((f) => /^image\/|application\/pdf/.test(f.type));
  if (!files.length) return toast('Choose photos (JPG/PNG) or PDFs', true);
  $('#importStart').classList.add('hidden');
  const prog = $('#importProgress');
  prog.classList.remove('hidden');
  for (let i = 0; i < files.length; i++) {
    prog.textContent = `Reading ticket ${i + 1} of ${files.length}: ${files[i].name}…`;
    try {
      const data = files[i].type === 'application/pdf' ? await fileToDataUrl(files[i]) : await shrinkImage(files[i]);
      const r = await api('read-ticket', { method: 'POST', body: { data } });
      const p = r.parsed || {};
      S.drafts.push({
        _key: Math.random().toString(36).slice(2), _err: r.error || '', _file: files[i].name, _raw: r.rawText || '',
        orderNo: p.orderNo, customer: p.customer, phone: p.phone, address: p.address, date: p.date || S.date,
        instructions: p.instructions, priority: /RUSH|ASAP|URGENT|FIRST THING|1ST/i.test(p.instructions || '') ? 'rush' : 'normal',
        lines: p.lines || [], overrides: {}, imageIds: [r.imageId], source: 'photo',
      });
    } catch (e) {
      S.drafts.push({ _key: Math.random().toString(36).slice(2), _err: e.message, _file: files[i].name, date: S.date, lines: [], overrides: {}, source: 'photo' });
    }
    renderDrafts();
  }
  prog.textContent = `Read ${files.length} ticket${files.length > 1 ? 's' : ''}. Check each one, teach any unknown items, then add them to the board.`;
}

function renderDrafts() {
  const box = $('#importReview');
  box.innerHTML = '';
  S.drafts.forEach((d, i) => {
    const el = h(`<div class="draft${d._skip ? ' skip' : ''}">
      <div class="draftHead"><b>${i + 1}. ${esc(d._file || 'Order')}</b>
        ${d._raw ? '<button type="button" class="btn small ghost" data-raw>Show raw text</button>' : ''}
        <label class="chk"><input type="checkbox" data-skip ${d._skip ? 'checked' : ''}> Skip</label></div>
      ${d._err ? `<div class="draftErr">${esc(d._err)} — fill it in by hand from the photo.</div>` : ''}
      <pre class="small muted hidden" data-rawtext style="white-space:pre-wrap;max-height:200px;overflow:auto">${esc(d._raw)}</pre>
      <div data-ed></div></div>`);
    $('[data-skip]', el).onchange = (e) => { d._skip = e.target.checked; el.classList.toggle('skip', d._skip); summary(); };
    $('[data-raw]', el)?.addEventListener('click', () => $('[data-rawtext]', el).classList.toggle('hidden'));
    if (!d._skip) orderEditor($('[data-ed]', el), d);
    box.appendChild(el);
  });
  $('#importFooter').classList.toggle('hidden', !S.drafts.length);
  summary();
}
function summary() {
  const keep = S.drafts.filter((d) => !d._skip);
  const unk = keep.reduce((s, d) => s + reqOf(d).unknown.length, 0);
  $('#importSummary').textContent = `${keep.length} order${keep.length === 1 ? '' : 's'}${unk ? ` · ${unk} item${unk > 1 ? 's' : ''} still untranslated` : ''}`;
  $('#importCommit').disabled = !keep.length;
}

$('#importCommit').onclick = async () => {
  const keep = S.drafts.filter((d) => !d._skip);
  const orders = keep.map((d) => {
    const o = {};
    for (const k of ['orderNo', 'customer', 'phone', 'address', 'date', 'priority', 'instructions', 'notes', 'windowStart', 'windowEnd', 'lines', 'overrides', 'imageIds', 'source']) if (d[k] !== undefined) o[k] = d[k];
    if (hasGeo(d)) { o.lat = d.lat; o.lng = d.lng; }
    return o;
  });
  try {
    const r = await api('orders/bulk', { method: 'POST', body: { orders } });
    toast(`Added ${r.created} order${r.created === 1 ? '' : 's'}${r.skipped.length ? ` · skipped ${r.skipped.length} already on the board` : ''}`);
    resetImport();
    importDlg.close();
    const dates = [...new Set(orders.map((o) => o.date))];
    if (dates.length === 1 && dates[0] !== S.date) setDate(dates[0]); else refresh(true);
  } catch (e) { toast(e.message, true); }
};

// ---- CSV / spreadsheet export
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  const delim = (text.split('\n')[0].match(/\t/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const CSV_FIELDS = [
  ['orderNo', 'Order #', /order|invoice|ticket|trans|doc/i], ['customer', 'Customer', /cust|sold|name|account/i],
  ['address', 'Address / street', /ship.*addr|deliv.*addr|address|street|addr1|job/i], ['city', 'Town', /city|town/i],
  ['state', 'State', /^state|^st$/i], ['zip', 'ZIP', /zip|postal/i], ['phone', 'Phone', /phone|tel/i],
  ['date', 'Delivery date', /deliv.*date|ship.*date|req.*date|due|date/i], ['sku', 'SKU / item #', /sku|item|product|part/i],
  ['desc', 'Description', /desc/i], ['qty', 'Quantity', /qty|quan/i], ['uom', 'Unit', /uom|unit/i],
  ['instructions', 'Instructions', /instr|note|comment|special/i],
];

$('#csvFile').onchange = async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  const rows = parseCsv(await file.text());
  if (rows.length < 2) return toast('That file has no rows', true);
  const head = rows[0];
  const guess = {};
  for (const [k, , re] of CSV_FIELDS) { const i = head.findIndex((c, ci) => re.test(c) && !Object.values(guess).includes(ci)); if (i !== -1) guess[k] = i; }
  const box = $('#csvMap');
  box.classList.remove('hidden');
  $('#importStart').classList.add('hidden');
  box.innerHTML = `<h3>Match the columns</h3><p class="muted small">${rows.length - 1} rows in ${esc(file.name)}. Rows with the same order # become one order.</p>
    <div class="csvMap">${CSV_FIELDS.map(([k, label]) => `<label>${label}<select data-col="${k}"><option value="">—</option>${head.map((c, i) => `<option value="${i}" ${guess[k] === i ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>`).join('')}</div>
    <div class="rowBtns" style="margin-top:10px"><button class="btn" data-cancel>Cancel</button><button class="btn primary" data-go>Build orders</button></div>`;
  $('[data-cancel]', box).onclick = resetImport;
  $('[data-go]', box).onclick = () => {
    const col = {};
    $$('[data-col]', box).forEach((s) => { if (s.value !== '') col[s.dataset.col] = Number(s.value); });
    const get = (r, k) => (col[k] != null ? String(r[col[k]] ?? '').trim() : '');
    const byOrder = new Map();
    for (const r of rows.slice(1)) {
      const key = get(r, 'orderNo') || `row${byOrder.size}`;
      if (!byOrder.has(key)) {
        let date = get(r, 'date');
        const m = date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
        if (m) date = `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
        if (!/^\d{4}-\d{2}-\d{2}/.test(date)) date = S.date;
        const address = [get(r, 'address'), get(r, 'city'), [get(r, 'state'), get(r, 'zip')].filter(Boolean).join(' ')].filter(Boolean).join(', ');
        byOrder.set(key, { _key: key, _file: `Order ${get(r, 'orderNo') || ''}`, orderNo: get(r, 'orderNo'), customer: get(r, 'customer'), phone: get(r, 'phone'), address, date: date.slice(0, 10), instructions: get(r, 'instructions'), priority: 'normal', lines: [], overrides: {}, source: 'csv' });
      }
      const sku = get(r, 'sku'), desc = get(r, 'desc');
      if (sku || desc) byOrder.get(key).lines.push({ qty: Number(get(r, 'qty')) || null, uom: get(r, 'uom'), sku, desc });
    }
    S.drafts.push(...byOrder.values());
    box.classList.add('hidden');
    renderDrafts();
  };
};

// ================================================================ translator: teach one item
const teachDlg = $('#teachDialog');
const teachForm = $('#teachForm');
let teaching = null;

function openTeach({ line, rule, scope }) {
  teaching = { line, rule };
  const f = teachForm.elements;
  teachForm.reset();
  if (rule) {
    f.match.value = rule.scope === 'ticket' ? 'ticket' : rule.match;
    f.pattern.value = rule.pattern;
    f.meaning.value = rule.meaning || '';
    f.lengthFt.value = rule.lengthFt ?? '';
    for (const k of ['boom', 'moffett', 'covered', 'ignore']) f[k].checked = !!rule[k];
  } else if (line) {
    f.match.value = line.sku ? 'sku' : 'contains';
    f.pattern.value = (line.sku || (line.desc || '').split(/\s+/).slice(0, 2).join(' ')).toUpperCase();
  } else {
    f.match.value = scope === 'ticket' ? 'ticket' : 'contains';
  }
  $('#teachTitle').textContent = rule ? 'Edit translation' : scope === 'ticket' ? 'Ticket phrase rule' : 'Teach the translator';
  $('#teachLine').innerHTML = line ? `<span class="sku">${esc(line.sku || '—')}</span>${esc(line.desc || '')}` : 'Applies to every ticket that matches.';
  $('#teachLine').classList.toggle('hidden', !line && !!rule);
  const parsed = line ? Shared.parseLength(`${line.sku} ${line.desc}`) : null;
  $('#teachParsed').textContent = parsed != null ? `Description reads as ${parsed}'. Leave blank to keep that.` : '';
  $('#teachDelete').classList.toggle('hidden', !rule);
  updateTeachHits();
  teachDlg.showModal();
  f.meaning.focus();
}

function draftRule() {
  const f = teachForm.elements;
  const ticket = f.match.value === 'ticket';
  return { match: ticket ? 'contains' : f.match.value, scope: ticket ? 'ticket' : 'line', pattern: f.pattern.value.trim().toUpperCase(), meaning: f.meaning.value.trim(),
    lengthFt: f.lengthFt.value === '' ? null : Number(f.lengthFt.value), boom: f.boom.checked, moffett: f.moffett.checked, covered: f.covered.checked, ignore: f.ignore.checked };
}
function updateTeachHits() {
  const r = draftRule();
  if (!r.pattern) { $('#teachHits').textContent = ''; return; }
  const pool = [...S.orders, ...S.drafts.filter((d) => !d._skip)];
  let lines = 0, orders = 0;
  for (const o of pool) {
    if (r.scope === 'ticket') { if (Shared.norm(`${o.instructions || ''} ${o.notes || ''}`).includes(r.pattern)) orders++; continue; }
    const n = (o.lines || []).filter((l) => Shared.evaluateLine(l, [{ ...r, id: '_t' }]).rule).length;
    lines += n; if (n) orders++;
  }
  $('#teachHits').textContent = r.scope === 'ticket' ? `Matches ${orders} order${orders === 1 ? '' : 's'} on screen.` : `Matches ${lines} line${lines === 1 ? '' : 's'} on ${orders} order${orders === 1 ? '' : 's'} on screen.`;
}
teachForm.addEventListener('input', updateTeachHits);

teachForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = draftRule();
  if (!r.pattern) return;
  try {
    const saved = teaching?.rule ? await api('lingo/' + teaching.rule.id, { method: 'PUT', body: r }) : await api('lingo', { method: 'POST', body: r });
    const i = S.lingo.findIndex((x) => x.id === saved.id);
    if (i === -1) S.lingo.push(saved); else S.lingo[i] = saved;
    teachDlg.close();
    toast(`Learned: ${saved.pattern}${saved.meaning ? ' = ' + saved.meaning : ''}`);
    afterLingoChange();
  } catch (err) { toast(err.message, true); }
});
$('#teachDelete').onclick = async () => {
  if (!teaching?.rule || !confirm('Delete this rule?')) return;
  await api('lingo/' + teaching.rule.id, { method: 'DELETE' });
  S.lingo = S.lingo.filter((x) => x.id !== teaching.rule.id);
  teachDlg.close();
  afterLingoChange();
};

function afterLingoChange() {
  for (const fn of [...refreshers]) fn();
  if (S.drafts.length) summary();
  render();
  if ($('#lingoDialog').open) renderLingo();
}

// ================================================================ translator manager
const lingoDlg = $('#lingoDialog');
let lingoTab = 'todo';
function openLingo() { renderLingo(); lingoDlg.showModal(); }
$$('#lingoDialog .tab').forEach((b) => b.onclick = () => { lingoTab = b.dataset.tab; renderLingo(); });
$('#lingoSearch').oninput = renderLingo;
$('#addTicketRule').onclick = () => openTeach({ scope: 'ticket' });
$('#addLineRule').onclick = () => openTeach({});

function renderLingo() {
  $$('#lingoDialog .tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === lingoTab));
  $('#lingoTodo').classList.toggle('hidden', lingoTab !== 'todo');
  $('#lingoRules').classList.toggle('hidden', lingoTab !== 'rules');
  const todo = unknownLines([...S.orders, ...S.drafts.filter((d) => !d._skip)]);
  $('#lingoDialog .tab[data-tab=todo]').textContent = `Needs translating (${todo.length})`;
  $('#lingoDialog .tab[data-tab=rules]').textContent = `Rules (${S.lingo.length})`;
  const tbox = $('#lingoTodo');
  tbox.innerHTML = todo.length ? '<div class="todoList"></div>' : '<p class="muted">Everything on this day is translated.</p>';
  for (const t of todo) {
    const el = h(`<div class="todoItem"><span class="sku">${esc(t.line.sku || '—')}</span><span class="d">${esc(t.line.desc || '')}</span>
      <span class="n">${t.count}× · ${esc([...t.orders].slice(0, 2).join(', '))}</span><button class="btn small primary">Teach</button></div>`);
    $('button', el).onclick = () => openTeach({ line: t.line });
    $('.todoList', tbox).appendChild(el);
  }
  const q = $('#lingoSearch').value.trim().toUpperCase();
  const rules = S.lingo.filter((r) => !q || `${r.pattern} ${r.meaning}`.toUpperCase().includes(q)).sort((a, b) => a.pattern.localeCompare(b.pattern));
  const label = { sku: 'SKU is', prefix: 'SKU starts', contains: 'Line has' };
  $('#lingoTable').innerHTML = `<thead><tr><th>When</th><th>Text</th><th>Means</th><th>Ft</th><th>Needs</th><th></th></tr></thead><tbody>${rules.map((r) => `
    <tr data-id="${r.id}"><td>${r.scope === 'ticket' ? 'Ticket says' : label[r.match]}</td><td><b style="font-family:var(--mono)">${esc(r.pattern)}</b></td><td>${esc(r.meaning || '')}</td>
      <td>${r.lengthFt ?? ''}</td><td><div class="tags">${r.boom ? '<span class="tag boom">Boom</span>' : ''}${r.moffett ? '<span class="tag fork">Moffett</span>' : ''}${r.covered ? '<span class="tag cov">Covered</span>' : ''}${r.ignore ? '<span class="tag">Not freight</span>' : ''}</div></td>
      <td><button class="btn small ghost" data-edit>Edit</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No rules yet. Teach from an unknown item, or add one.</td></tr>'}</tbody>`;
  $$('#lingoTable [data-edit]').forEach((b) => b.onclick = () => openTeach({ rule: S.lingo.find((r) => r.id === b.closest('tr').dataset.id) }));
}

// ================================================================ trucks
const trucksDlg = $('#trucksDialog');
function openTrucks() { renderTruckRows(); trucksDlg.showModal(); }

function renderTruckRows() {
  const types = S.config.truckTypes || [];
  const rows = sortedTrucks();
  $('#truckRows').innerHTML = rows.map((t) => `
    <tr data-id="${t.id}">
      <td><div class="swatches">${PALETTE.map(([n, c]) => `<button type="button" title="${n}" data-color="${c}" class="${c.toLowerCase() === (t.color || '').toLowerCase() ? 'on' : ''}" style="background:${c}"></button>`).join('')}</div></td>
      <td><div style="display:flex;gap:6px;align-items:center"><input class="code" data-k="code" value="${esc(t.code || '')}" placeholder="${esc(truckCode({ ...t, code: '' }))}" maxlength="4"><input data-k="name" value="${esc(t.name)}"></div></td>
      <td><select data-k="type">${types.map((x) => `<option ${x === t.type ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></td>
      <td><input data-k="driver" value="${esc(t.driver || '')}" placeholder="—"></td>
      <td><input type="number" data-k="maxLength" min="0" step="1" value="${t.maxLength ?? ''}"></td>
      <td><input type="number" data-k="maxStops" min="1" step="1" value="${t.maxStops ?? ''}" placeholder="5"></td>
      <td><input type="number" data-k="maxTrips" min="1" step="1" value="${t.maxTrips ?? ''}" placeholder="3"></td>
      <td class="c"><input type="checkbox" data-k="hasBoom" ${t.hasBoom ? 'checked' : ''}></td>
      <td class="c"><input type="checkbox" data-k="hasForklift" ${t.hasForklift ? 'checked' : ''}></td>
      <td class="c"><input type="checkbox" data-k="covered" ${t.covered ? 'checked' : ''}></td>
      <td class="c"><input type="checkbox" data-k="active" ${t.active ? 'checked' : ''}></td>
      <td><button class="btn icon ghost" data-del title="Remove truck">✕</button></td>
    </tr>`).join('') || '<tr><td colspan="12" class="muted" style="padding:14px 4px">No trucks yet. Add one below.</td></tr>';

  const save = async (tid, patch) => {
    try { Object.assign(truckById(tid), await api('trucks/' + tid, { method: 'PUT', body: patch })); render(); }
    catch (e) { toast(e.message, true); }
  };
  $$('#truckRows tr[data-id]').forEach((tr) => {
    const tid = tr.dataset.id;
    $$('[data-k]', tr).forEach((inp) => inp.addEventListener('change', () => {
      const k = inp.dataset.k;
      const v = inp.type === 'checkbox' ? inp.checked : inp.value;
      const patch = { [k]: v };
      if (k === 'type' && v === 'Boom truck') { patch.hasBoom = true; $('[data-k=hasBoom]', tr).checked = true; }
      if (k === 'type' && v === 'Flatbed + Moffett') { patch.hasForklift = true; $('[data-k=hasForklift]', tr).checked = true; }
      if (k === 'type' && v === 'Box truck') { patch.covered = true; $('[data-k=covered]', tr).checked = true; }
      save(tid, patch);
    }));
    $$('[data-color]', tr).forEach((b) => b.onclick = async () => { await save(tid, { color: b.dataset.color }); renderTruckRows(); });
    $('[data-del]', tr).onclick = async () => {
      const n = S.orders.filter((o) => o.truckId === tid).length;
      if (!confirm(`Remove ${truckById(tid).name}?${n ? ` Its ${n} order(s) on this day go back to Unassigned.` : ''}`)) return;
      await api('trucks/' + tid, { method: 'DELETE' });
      await refresh(true);
      renderTruckRows();
    };
  });
}

$('#addTruck').onclick = async () => {
  const n = S.trucks.length;
  try {
    const t = await api('trucks', { method: 'POST', body: { name: `Truck ${n + 1}`, type: 'Flatbed + Moffett', hasForklift: true, color: PALETTE[n % PALETTE.length][1], maxLength: 24, maxStops: 5, maxTrips: 3, active: true } });
    S.trucks.push(t);
    renderTruckRows();
    render();
    $(`#truckRows tr[data-id="${t.id}"] [data-k=name]`)?.select();
  } catch (e) { toast(e.message, true); }
};
trucksDlg.addEventListener('close', () => refresh(true));

// ================================================================ settings
const settingsDlg = $('#settingsDialog');
const settingsForm = $('#settingsForm');
function openSettings() {
  const f = settingsForm.elements;
  const s = S.settings;
  f.companyName.value = s.companyName || '';
  f.yardAddress.value = s.yard?.address || '';
  f.yardLat.value = s.yard?.lat ?? '';
  f.yardLng.value = s.yard?.lng ?? '';
  f.ticketReader.value = s.ticketReader || 'auto';
  f.claudeApiKey.value = s.hasApiKey && !s.apiKeyFromEnv ? '********' : '';
  f.claudeApiKey.disabled = !!s.apiKeyFromEnv;
  $('#keyNote').textContent = s.apiKeyFromEnv ? 'Key is set by the ANTHROPIC_API_KEY environment variable.' : s.hasApiKey ? 'A key is saved. Clear the field and save to remove it.' : 'Get a key at console.anthropic.com. Reading a ticket costs a few cents.';
  $('#yardResults').innerHTML = '';
  setYardStatus(hasGeo(s.yard) ? 'ok' : '', hasGeo(s.yard) ? 'Yard is on the map' : 'Set the yard so routes start and end there');
  settingsDlg.showModal();
}
function setYardStatus(cls, text) { const el = $('#yardStatus'); el.className = 'geoStatus ' + cls; el.textContent = text; }
async function findYard(auto) {
  const f = settingsForm.elements;
  const q = f.yardAddress.value.trim();
  if (q.length < 3) return setYardStatus('bad', 'Type an address first');
  setYardStatus('', 'Searching…');
  try {
    const list = await api('geocode?q=' + encodeURIComponent(q));
    if (!list.length) return setYardStatus('bad', 'No match. Try adding the town and state, or use Pin on map.');
    const pick = (r) => { f.yardLat.value = r.lat; f.yardLng.value = r.lng; $('#yardResults').innerHTML = ''; setYardStatus('ok', r.label); };
    if (auto || list.length === 1) return pick(list[0]);
    $('#yardResults').innerHTML = '';
    list.forEach((r) => { const b = h(`<button type="button">${esc(r.label)}</button>`); b.onclick = () => pick(r); $('#yardResults').appendChild(b); });
    setYardStatus('', 'Pick the right match:');
  } catch (e) { setYardStatus('bad', e.message); }
}
$('#yardSearch').onclick = () => findYard(false);
$('#yardInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); findYard(false); } });
$('#yardInput').addEventListener('input', () => { settingsForm.elements.yardLat.value = ''; settingsForm.elements.yardLng.value = ''; setYardStatus('', 'Not located yet — press Find'); });
$('#yardPick').onclick = () => {
  settingsDlg.close();
  startPick((ll) => {
    if (ll) { settingsForm.elements.yardLat.value = ll.lat.toFixed(6); settingsForm.elements.yardLng.value = ll.lng.toFixed(6); setYardStatus('ok', `Pinned at ${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`); }
    expandMap(false);
    settingsDlg.showModal();
  });
};
settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = settingsForm.elements;
  if (f.yardAddress.value.trim() && !f.yardLat.value) await findYard(true);
  const body = { companyName: f.companyName.value, yard: { address: f.yardAddress.value, lat: f.yardLat.value, lng: f.yardLng.value }, ticketReader: f.ticketReader.value };
  if (!f.claudeApiKey.disabled) body.claudeApiKey = f.claudeApiKey.value;
  try {
    S.settings = await api('settings', { method: 'PUT', body });
    settingsDlg.close();
    S.routes.clear(); fitDone = false;
    render();
    toast('Settings saved');
  } catch (err) { toast(err.message, true); }
});
$('#rollOver').onclick = async () => {
  const left = S.orders.filter((o) => o.status !== 'delivered');
  if (!left.length) return toast('Nothing undelivered on this day');
  const next = shiftDate(S.date, 1);
  if (!confirm(`Move ${left.length} undelivered order(s) to ${niceDate(next)}? They'll land in Unassigned.`)) return;
  for (const o of left) await api('orders/' + o.id, { method: 'PUT', body: { date: next, truckId: null, trip: 1, status: 'open', planReason: '' } });
  settingsDlg.close();
  toast(`Moved ${left.length} order(s) to ${niceDate(next)}`);
  refresh(true);
};
$('#importBackup').onchange = async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file || !confirm('Replace ALL trucks, orders, translator rules and settings with this backup?')) return;
  try { await api('import', { method: 'POST', body: JSON.parse(await file.text()) }); settingsDlg.close(); toast('Backup restored'); refresh(true); }
  catch (err) { toast('Restore failed: ' + err.message, true); }
};

// ================================================================ run sheet
function printRunSheet(truckId) {
  const truck = truckById(truckId);
  const col = buildColumns().find((c) => c.truck?.id === truckId);
  if (!col || !col.trips.length) return toast(`${truck.name} has no stops on this day`, true);
  const trips = col.trips.map((trip) => {
    const pts = tripPoints(trip);
    const rt = pts.length >= 2 ? S.routes.get(routeKey(pts)) : null;
    const rows = trip.orders.map((o, i) => {
      const req = reqOf(o);
      const items = (o.lines || []).filter((l, li) => !req.lines[li]?.ignore).map((l) => `${l.qty ?? ''} ${esc(l.uom || '')} ${esc(l.desc || l.sku || '')}`).join('<br>');
      return `<tr><td class="n">${i + 1}</td>
        <td><b>${esc(o.customer)}</b>${o.orderNo ? `<br><small>#${esc(o.orderNo)}</small>` : ''}${o.phone ? `<br><small>${esc(o.phone)}</small>` : ''}${o.priority === 'rush' ? '<br><b>RUSH</b>' : ''}</td>
        <td>${esc(o.address)}${o.windowStart || o.windowEnd ? `<br><b>Window ${fmtTime(o.windowStart)}–${fmtTime(o.windowEnd)}</b>` : ''}${o.instructions ? `<div class="note">${esc(o.instructions)}</div>` : ''}${o.notes ? `<div class="note">${esc(o.notes)}</div>` : ''}</td>
        <td class="items">${items}</td>
        <td>${[req.lengthFt != null && req.lengthFt + "'", req.boom && 'BOOM', req.moffett && 'MOFFETT', req.covered && 'COVERED'].filter(Boolean).join('<br>')}</td>
        <td class="sig"></td></tr>`;
    }).join('');
    return `<h2>Trip ${trip.n}${rt && typeof rt === 'object' ? ` <small>${rt.distanceMiles.toFixed(0)} mi · ${fmtMin(rt.durationMin)} driving</small>` : ''}</h2>
      <table><thead><tr><th>#</th><th>Customer</th><th>Deliver to</th><th>Load</th><th>Needs</th><th>Signed / time</th></tr></thead><tbody>${rows}</tbody></table>`;
  }).join('');
  const w = window.open('', '_blank');
  if (!w) return toast('Allow pop-ups to print run sheets', true);
  w.document.write(`<!doctype html><html><head><title>${esc(truck.name)} — ${S.date}</title><style>
    body{font:12px/1.35 system-ui,Arial,sans-serif;margin:24px;color:#111}h1{margin:0;font-size:20px}
    .hdr{display:flex;justify-content:space-between;border-bottom:3px solid #111;padding-bottom:6px;margin-bottom:10px}
    h2{font-size:15px;margin:16px 0 6px}h2 small{font-weight:400;color:#444}table{width:100%;border-collapse:collapse}
    th,td{border:1px solid #999;padding:5px;vertical-align:top;text-align:left}th{background:#eee;font-size:11px;text-transform:uppercase}
    td.n{font-weight:700;font-size:15px;text-align:center;width:24px}td.sig{width:110px}td.items{font-size:11px}.note{margin-top:4px;font-style:italic}small{color:#444}
    @media print{body{margin:10mm}}</style></head><body>
    <div class="hdr"><div><h1>${esc(truckCode(truck))} · ${esc(truck.name)} — run sheet</h1>${esc(S.settings.companyName || '')}</div>
    <div style="text-align:right"><b>${niceDate(S.date)}</b><br>Driver: ${esc(truck.driver || '________________')}${S.settings.yard?.address ? `<br>From: ${esc(S.settings.yard.address)}` : ''}</div></div>
    ${trips}<script>window.onload=()=>window.print()<\/script></body></html>`);
  w.document.close();
}

// ================================================================ data loading
async function refresh(force = false) {
  try {
    const data = await api('state?date=' + S.date);
    const hash = JSON.stringify(data);
    if (!force && hash === S.lastHash) return;
    S.lastHash = hash;
    Object.assign(S, { settings: data.settings, trucks: data.trucks, orders: data.orders, lingo: data.lingo });
    render();
  } catch (e) { toast('Could not reach the server: ' + e.message, true); }
}

function setDate(d) {
  S.date = d;
  $('#dateInput').value = d;
  S.selected = null; S.focusTruck = null;
  fitDone = false; S.lastHash = '';
  refresh(true);
}

// ================================================================ wiring
$('#dateInput').onchange = (e) => e.target.value && setDate(e.target.value);
$('#prevDay').onclick = () => setDate(shiftDate(S.date, -1));
$('#nextDay').onclick = () => setDate(shiftDate(S.date, 1));
$('#todayBtn').onclick = () => setDate(todayStr());
$('#importBtn').onclick = openImport;
$('#newOrderBtn').onclick = () => openOrder(null);
$('#lingoBtn').onclick = openLingo;
$('#trucksBtn').onclick = openTrucks;
$('#settingsBtn').onclick = openSettings;
$$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

setInterval(() => { if (!document.hidden && !S.dragging && !$('dialog[open]') && !pickCallback) refresh(); }, 15000);

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, dialog')) return;
  if (e.key === 'n') { e.preventDefault(); openOrder(null); }
  if (e.key === 'i') { e.preventDefault(); openImport(); }
  if (e.key === 'ArrowLeft' && e.altKey) setDate(shiftDate(S.date, -1));
  if (e.key === 'ArrowRight' && e.altKey) setDate(shiftDate(S.date, 1));
  if (e.key === 'Enter' && S.selected) openOrder(S.selected);
  if (e.key === 'Escape') { if ($('#miniMap').classList.contains('big')) expandMap(false); S.focusTruck = null; S.selected = null; renderBoard(); renderMap(true); }
});

(async function init() {
  try { S.config = await api('config'); } catch {}
  $('#dateInput').value = S.date;
  initMap();
  await refresh(true);
})();
})();
