/* Logic shared by the server and the browser:
 *  - reading lengths out of lumber descriptions ("2X10-16 #2 SYP" -> 16 ft)
 *  - the translator ("lingo") that maps SKUs / shorthand to what they mean for a truck
 *  - working out what an order needs (deck length, boom, Moffett, covered)
 *  - the auto-dispatch planner
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ lengths

  const FRACTION = '\\d+(?:[-\\s]\\d+\\/\\d+|\\.\\d+|\\/\\d+)?';
  const DIM3 = new RegExp(`(${FRACTION})\\s*X\\s*(${FRACTION})\\s*(?:X|-)\\s*(\\d{1,3})(?:-\\d+\\/\\d+)?(?=[^\\d]|$)`);
  const FEET = /(?:^|[^\d\/])(\d{1,2})\s*(?:'|FT\b|FEET\b|FOOT\b)/;
  const SHEET = /(?:^|[^\d\/-])4\s*X\s*(8|9|10|12)(?![\d\/])/;

  /** Best guess at the length (in feet) of a material from its SKU/description, or null. */
  function parseLength(text) {
    if (!text) return null;
    const t = String(text).toUpperCase().replace(/[″”]/g, '"').replace(/[′’]/g, "'");
    let m = t.match(DIM3);
    if (m) {
      const n = Number(m[3]);
      if (n >= 4 && n <= 60) return n;
      if (n > 60 && n <= 300) return Math.ceil(n / 12); // inches, e.g. 92-5/8 precut stud
    }
    m = t.match(FEET);
    if (m) { const n = Number(m[1]); if (n >= 2 && n <= 60) return n; }
    m = t.match(SHEET);
    if (m) return Number(m[1]);
    return null;
  }

  // ------------------------------------------------------------------ translator

  const norm = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();

  /** How specific a rule is — more specific rules win. */
  function ruleRank(r) {
    const base = { sku: 3000, prefix: 2000, contains: 1000 }[r.match] || 0;
    return base + norm(r.pattern).length;
  }

  function ruleMatchesLine(r, line) {
    if (r.scope === 'ticket') return false;
    const p = norm(r.pattern);
    if (!p) return false;
    const sku = norm(line.sku);
    if (r.match === 'sku') return sku === p;
    if (r.match === 'prefix') return sku.startsWith(p);
    if (r.match === 'contains') return (` ${sku} ${norm(line.desc)} `).includes(p);
    return false;
  }

  function ruleMatchesTicket(r, text) {
    if (r.scope !== 'ticket') return false;
    const p = norm(r.pattern);
    return !!p && norm(text).includes(p);
  }

  /** What one ticket line means for a truck. */
  function evaluateLine(line, rules) {
    const matches = (rules || []).filter((r) => ruleMatchesLine(r, line)).sort((a, b) => ruleRank(b) - ruleRank(a));
    const rule = matches[0] || null;
    const parsed = parseLength(`${line.sku || ''} ${line.desc || ''}`);
    const pick = (k) => matches.map((r) => r[k]).find((v) => v !== null && v !== undefined && v !== '');
    const lengthFt = num(line.lengthFt) ?? num(pick('lengthFt')) ?? parsed;
    return {
      rule,
      meaning: rule?.meaning || '',
      lengthFt,
      lengthSource: num(line.lengthFt) != null ? 'manual' : num(pick('lengthFt')) != null ? 'translator' : parsed != null ? 'description' : null,
      boom: matches.some((r) => r.boom),
      moffett: matches.some((r) => r.moffett),
      covered: matches.some((r) => r.covered),
      ignore: !!line.ignore || matches.some((r) => r.ignore),
      known: !!rule || parsed != null || num(line.lengthFt) != null || !!line.ignore,
    };
  }

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** Everything the order needs from a truck, with the reason for each need. */
  function orderRequirements(order, rules) {
    const req = { lengthFt: null, lengthWhy: '', boom: false, moffett: false, covered: false, why: {}, unknown: [], lines: [] };
    for (const line of order.lines || []) {
      const ev = evaluateLine(line, rules);
      req.lines.push(ev);
      if (ev.ignore) continue;
      if (!ev.known) req.unknown.push(line);
      if (ev.lengthFt != null && (req.lengthFt == null || ev.lengthFt > req.lengthFt)) {
        req.lengthFt = ev.lengthFt;
        req.lengthWhy = line.desc || line.sku || '';
      }
      for (const k of ['boom', 'moffett', 'covered']) {
        if (ev[k] && !req[k]) { req[k] = true; req.why[k] = ev.meaning || line.desc || line.sku; }
      }
    }
    const ticketText = [order.instructions, order.notes].filter(Boolean).join(' ');
    for (const r of (rules || []).filter((x) => ruleMatchesTicket(x, ticketText))) {
      for (const k of ['boom', 'moffett', 'covered']) {
        if (r[k] && !req[k]) { req[k] = true; req.why[k] = `ticket says "${r.pattern}"`; }
      }
    }
    const ov = order.overrides || {};
    for (const k of ['boom', 'moffett', 'covered']) {
      if (ov[k] === true) { req[k] = true; req.why[k] = 'set by dispatcher'; }
      if (ov[k] === false) { req[k] = false; delete req.why[k]; }
    }
    if (num(ov.lengthFt) != null) { req.lengthFt = num(ov.lengthFt); req.lengthWhy = 'set by dispatcher'; }
    return req;
  }

  /** Reasons this truck can't take this order (empty = it can). */
  function truckProblems(truck, req) {
    const p = [];
    if (!truck) return p;
    if (req.boom && !truck.hasBoom) p.push(`needs boom (${req.why.boom}) — ${truck.name} has none`);
    if (req.moffett && !truck.hasForklift) p.push(`needs Moffett (${req.why.moffett}) — ${truck.name} has none`);
    if (req.covered && !truck.covered) p.push(`needs covered truck (${req.why.covered}) — ${truck.name} is open`);
    if (req.lengthFt != null && num(truck.maxLength) != null && req.lengthFt > truck.maxLength) {
      p.push(`${req.lengthFt}' material, ${truck.name} carries ${truck.maxLength}'`);
    }
    return p;
  }

  // ------------------------------------------------------------------ planner

  const ROAD_FACTOR = 1.3; // straight-line miles -> rough road miles
  function miles(a, b) {
    if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(b.lat)) return null;
    const R = 3958.8, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x)) * ROAD_FACTOR;
  }
  const hasGeo = (o) => Number.isFinite(o?.lat) && Number.isFinite(o?.lng);

  function tourMiles(stops, yard) {
    const pts = [yard, ...stops.filter(hasGeo), yard].filter(hasGeo);
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += miles(pts[i - 1], pts[i]);
    return d;
  }

  /** Cheapest place to slot `o` into an ordered list of stops. */
  function cheapestInsert(stops, o, yard) {
    if (!hasGeo(o)) return { idx: stops.length, delta: 0 };
    const pts = [yard, ...stops, yard];
    let best = { idx: stops.length, delta: Infinity };
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const ga = hasGeo(a) ? a : null, gb = hasGeo(b) ? b : null;
      let delta;
      if (ga && gb) delta = miles(ga, o) + miles(o, gb) - miles(ga, gb);
      else if (ga || gb) delta = miles(ga || gb, o);
      else delta = 0;
      if (delta < best.delta) best = { idx: i, delta };
    }
    return best;
  }

  function twoOpt(stops, yard) {
    const geo = stops.filter(hasGeo), rest = stops.filter((s) => !hasGeo(s));
    let tour = [...geo], improved = true, guard = 0;
    while (improved && guard++ < 200) {
      improved = false;
      for (let i = 0; i < tour.length - 1; i++) {
        for (let k = i + 1; k < tour.length; k++) {
          const cand = [...tour.slice(0, i), ...tour.slice(i, k + 1).reverse(), ...tour.slice(k + 1)];
          if (tourMiles(cand, yard) + 1e-6 < tourMiles(tour, yard)) { tour = cand; improved = true; }
        }
      }
    }
    return [...tour, ...rest];
  }

  const PRIORITY_RANK = { rush: 0, normal: 1, low: 2 };
  const NEW_TRIP_PENALTY = 6;      // miles-equivalent cost of loading another trip
  const LATE_RUSH_PENALTY = 60;    // keep rush orders on a truck's first trip
  const SPARE_PENALTY = 6;         // keep boom / covered trucks free for the jobs that need them
  const BALANCE_PENALTY = 4;       // per stop already on the truck, spreads work around

  /**
   * Propose truck/trip/stop order for a day's orders.
   * Orders already confirmed by the dispatcher (assign === 'confirmed') stay where they are.
   * Returns { assignments: [{id, truckId, trip, seq, reason}], unplaced: [{id, reason}] }
   */
  function planDay({ orders, trucks, yard, rules }) {
    yard = hasGeo(yard) ? yard : null;
    const active = trucks.filter((t) => t.active);
    const state = new Map(active.map((t) => [t.id, { truck: t, trips: [] }]));
    const fixedIds = new Set();

    for (const o of orders) {
      if (o.status === 'delivered' || (o.truckId && o.assign === 'confirmed') || (o.truckId && o.status === 'loaded')) {
        fixedIds.add(o.id);
        const st = state.get(o.truckId);
        if (!st) continue;
        const n = (o.trip || 1) - 1;
        while (st.trips.length <= n) st.trips.push({ stops: [], locked: false });
        st.trips[n].stops.push(o);
        st.trips[n].locked = true;
      }
    }
    for (const st of state.values()) for (const tr of st.trips) tr.stops.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

    const reqs = new Map(orders.map((o) => [o.id, orderRequirements(o, rules)]));
    const todo = orders.filter((o) => !fixedIds.has(o.id));
    const eligible = new Map(todo.map((o) => [o.id, active.filter((t) => truckProblems(t, reqs.get(o.id)).length === 0)]));

    todo.sort((a, b) =>
      (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1) ||
      eligible.get(a.id).length - eligible.get(b.id).length ||
      (miles(yard, b) ?? 0) - (miles(yard, a) ?? 0) ||
      String(a.orderNo || '').localeCompare(String(b.orderNo || '')));

    const assignments = [], unplaced = [];
    const reasonOf = new Map();

    for (const o of todo) {
      const req = reqs.get(o.id);
      const okTrucks = eligible.get(o.id);
      if (!okTrucks.length) {
        const why = active.length ? truckProblems(active[0], req)[0] || 'no truck fits' : 'no trucks on the board';
        const needs = [req.boom && 'a boom', req.moffett && 'a Moffett', req.covered && 'a covered truck', req.lengthFt && `${req.lengthFt}' of deck`].filter(Boolean);
        unplaced.push({ id: o.id, reason: needs.length ? `No truck on the board has ${needs.join(' + ')}` : why });
        continue;
      }
      let best = null;
      for (const t of okTrucks) {
        const st = state.get(t.id);
        const maxStops = num(t.maxStops) || 6;
        const maxTrips = num(t.maxTrips) || 4;
        const used = st.trips.reduce((s, tr) => s + tr.stops.length, 0);
        const candidates = st.trips.map((tr, i) => ({ i, tr })).filter(({ tr }) => tr.stops.length < maxStops);
        if (st.trips.length < maxTrips) candidates.push({ i: st.trips.length, tr: null });
        for (const { i, tr } of candidates) {
          let cost, idx, near = null;
          if (tr) {
            const ins = cheapestInsert(tr.stops, o, yard);
            cost = ins.delta; idx = ins.idx;
            near = tr.stops.filter(hasGeo).map((s) => ({ s, d: miles(s, o) })).sort((a, b) => a.d - b.d)[0] || null;
          } else {
            cost = (yard && hasGeo(o) ? 2 * miles(yard, o) : 10) + NEW_TRIP_PENALTY; idx = 0;
          }
          if (!hasGeo(o)) cost += 5;
          cost += i * 2;
          if (o.priority === 'rush' && i > 0) cost += LATE_RUSH_PENALTY;
          if (t.hasBoom && !req.boom) cost += SPARE_PENALTY;
          if (t.covered && !req.covered) cost += SPARE_PENALTY;
          cost += used * BALANCE_PENALTY;
          if (!best || cost < best.cost) best = { cost, truck: t, tripIdx: i, idx, near, isNew: !tr };
        }
      }
      if (!best) { unplaced.push({ id: o.id, reason: 'Every qualifying truck is full (stops/trips limit)' }); continue; }
      const st = state.get(best.truck.id);
      if (best.isNew) st.trips.push({ stops: [o], locked: false });
      else st.trips[best.tripIdx].stops.splice(best.idx, 0, o);

      const bits = [];
      const needs = [req.boom && 'boom', req.moffett && 'Moffett', req.covered && 'covered'].filter(Boolean);
      if (okTrucks.length === 1 && (needs.length || req.lengthFt)) bits.push(`only ${best.truck.name} has ${needs.length ? needs.join(' + ') : `${req.lengthFt}' of deck`}`);
      else if (needs.length) bits.push(`needs ${needs.join(' + ')}`);
      if (o.priority === 'rush') bits.push('rush');
      reasonOf.set(o.id, bits);
    }

    // explain each placement by where it ended up
    const explain = (o, stops, ti) => {
      const bits = [...(reasonOf.get(o.id) || [])];
      if (!hasGeo(o)) bits.push('address not located — placed without distance');
      else {
        const near = stops.filter((s) => s !== o && hasGeo(s)).map((s) => ({ s, d: miles(s, o) })).sort((a, b) => a.d - b.d)[0];
        if (near) bits.push(`~${near.d.toFixed(1)} mi from ${near.s.customer || 'another stop'}`);
        else bits.push(ti > 0 ? `own trip (${ti + 1})` : 'only stop on this trip');
      }
      return bits.join(' · ');
    };

    for (const st of state.values()) {
      st.trips.forEach((tr, ti) => {
        let stops = tr.stops;
        if (!tr.locked) stops = twoOpt(stops, yard);
        const rush = stops.filter((s) => s.priority === 'rush');
        if (rush.length) stops = [...rush, ...stops.filter((s) => s.priority !== 'rush')];
        stops.forEach((s, si) => {
          if (fixedIds.has(s.id)) {
            if (s.seq !== si || (s.trip || 1) !== ti + 1) assignments.push({ id: s.id, truckId: st.truck.id, trip: ti + 1, seq: si, keep: true });
          } else {
            assignments.push({ id: s.id, truckId: st.truck.id, trip: ti + 1, seq: si, reason: explain(s, stops, ti) });
          }
        });
      });
    }
    return { assignments, unplaced };
  }

  return { parseLength, evaluateLine, orderRequirements, truckProblems, planDay, miles, hasGeo, twoOpt, tourMiles, norm };
});
