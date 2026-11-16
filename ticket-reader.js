// Reads a photo of a Chace Building Supply (Epicor) order ticket into a structured order.
// Free and local: ImageMagick cleans the photo, Tesseract OCR reads it, and a parser that knows
// the Epicor ticket layout sorts the words into fields using where they sit on the page.
//
// Two OCR passes are made (photo as-is, and a locally-thresholded copy that evens out shadows);
// the parse that comes out more complete wins, and missing fields are filled from the other.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, timeout: 120000, ...opts }, (err, stdout, stderr) => {
    if (err) return reject(Object.assign(new Error(err.code === 'ENOENT' ? `${cmd} is not installed` : `${cmd} failed: ${stderr || err.message}`), { code: err.code }));
    resolve(stdout);
  });
});

// ------------------------------------------------------------------ OCR

async function ocrWords(file, psm = 4) {
  const tsv = await run('tesseract', [file, 'stdout', '--psm', String(psm), 'tsv']);
  const words = [];
  for (const row of tsv.split('\n').slice(1)) {
    const c = row.split('\t');
    if (c.length < 12 || c[0] !== '5') continue;
    const t = c[11].trim();
    if (!t) continue;
    words.push({ t, x: +c[6], y: +c[7], w: +c[8], h: +c[9], conf: +c[10], key: `${c[2]}/${c[3]}/${c[4]}` });
  }
  return words;
}

function toLines(words) {
  const map = new Map();
  for (const w of words) {
    if (!map.has(w.key)) map.set(w.key, []);
    map.get(w.key).push(w);
  }
  const lines = [...map.values()].map((ws) => {
    ws.sort((a, b) => a.x - b.x);
    const y = Math.min(...ws.map((w) => w.y));
    const h = Math.max(...ws.map((w) => w.y + w.h)) - y;
    return { words: ws, y, h, x: ws[0].x, text: ws.map((w) => w.t).join(' ') };
  });
  lines.sort((a, b) => a.y - b.y || a.x - b.x);
  // OCR sometimes reads a column as its own block; stitch pieces that sit at the same height back into one row
  const rows = [];
  for (const l of lines) {
    const cy = l.y + l.h / 2;
    const blk = l.words[0].key.split('/')[0];
    const row = rows.find((r) => !r.blocks.has(blk) && Math.abs((r.y + r.h / 2) - cy) < Math.min(r.h, l.h) * 0.5
      && !r.words.some((w) => l.words.some((v) => v.x < w.x + w.w && w.x < v.x + v.w)));
    if (row) {
      row.words.push(...l.words);
      row.words.sort((p, q) => p.x - q.x);
      row.y = Math.min(row.y, l.y);
      row.h = Math.max(row.h, l.h);
      row.x = row.words[0].x;
      row.text = row.words.map((w) => w.t).join(' ');
      row.blocks.add(blk);
    } else rows.push({ ...l, words: [...l.words], blocks: new Set([blk]) });
  }
  return rows.sort((a, b) => a.y - b.y || a.x - b.x);
}

// ------------------------------------------------------------------ helpers

const UPPER = (s) => String(s || '').toUpperCase();
const clean = (s) => String(s || '').replace(/[|\[\]{}_~`“”‘’"]+/g, ' ').replace(/\s+/g, ' ').trim();
const PHONE = /\(?\b(\d{3})\)?[\s.\-]{0,2}(\d{3})[\s.\-]{1,2}(\d{4})\b/;
const COMPANY_PHONES = ['8609282747'];
const STATES = 'CT|MA|RI|NY|NH|VT|ME|NJ|PA';
const STATE_RE = new RegExp(`\\b(${STATES})\\b`);
const UMS = ['EA', 'BX', 'LF', 'PC', 'PCS', 'SF', 'BF', 'BD', 'BDL', 'RL', 'SQ', 'BG', 'BAG', 'PR', 'CT', 'CS', 'GAL', 'LB', 'SH', 'SHT', 'KT', 'KIT', 'ST', 'SET', 'TB', 'TUB', 'PK', 'PL', 'PAIL', 'MBF', 'MSF', 'CTN', 'UN', 'DZ'];
const UM_RE = new RegExp(`^(${UMS.join('|')})(?=$|[^A-Z])`);
const SEP = /[|/\\\]\[}{Jjl!]/;

const INSTRUCTION = /\bDELIVER|DELIVERY|\bSHIP\b|\bCALL\b|ASAP|TODAY|TOMORROW|NEXT AVAIL|PLEASE|DRIVEWAY|\bLOT\b|\bGATE\b|\bDROP\b|\bPLACE\b|PICK ?UP|\b\d?\s?(AM|PM)\b|BEFORE|AFTER|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|\bBOOM\b|\bROOF\b|\bLEAVE\b|JOB ?SITE|BACK ?YARD|GARAGE|\bSIDE\b|\bREAR\b|\bFRONT\b|HAND ?UNLOAD|SOONER|RUSH|URGENT|FIRST THING|1ST THING/;
const BOILERPLATE = /RETURNABLE|DEPOSIT|DUE TO THE NATURE|^PRODUCT\b|PRODUCT,|^REF\b|QUOTE|<>|<\s*>|SPECIAL ORDER|^#?\s*\d{5,}$|^[\W\d]*$/;
const FOOTER = /TAXABLE|SUBTOTAL|BALANCE|DEPOSIT AMT|TOT\s*\.?\s*WT|RECEIVED BY|TAX AMOUNT/;

function normPhone(s) {
  const m = PHONE.exec(s || '');
  if (!m) return '';
  const d = m[1] + m[2] + m[3];
  if (COMPANY_PHONES.includes(d)) return '';
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// OCR confusions used when matching a misread SKU to one we already know.
const CONFUSE = { O: '0', D: '0', Q: '0', I: '1', L: '1', J: '1', '|': '1', '!': '1', S: '8', 5: '8', B: '8', $: '8', Z: '2', G: '6' };
const fold = (s) => UPPER(s).split('').map((c) => CONFUSE[c] || c).join('');

function correctSku(sku, known) {
  if (!sku || !known || !known.size) return { sku, corrected: false };
  const up = UPPER(sku);
  if (known.has(up)) return { sku: up, corrected: false };
  const tries = [up, up.replace(/^[IJL1|!S]/, ''), up.replace(/[IJL1|!]$/, '')];
  for (const t of tries) if (known.has(t)) return { sku: t, corrected: t !== up };
  const folded = new Map();
  for (const k of known) {
    const f = fold(k);
    folded.set(f, folded.has(f) && folded.get(f) !== k ? null : k);
  }
  for (const t of tries) {
    const hit = folded.get(fold(t));
    if (hit) return { sku: hit, corrected: true };
  }
  return { sku: up, corrected: false };
}

// ------------------------------------------------------------------ header (sold to / ship to / dates)

/** Split a line into segments wherever there's a wide horizontal gap. */
function segments(line, gap) {
  const segs = [];
  let cur = null;
  for (const w of line.words) {
    if (cur && w.x - (cur.x2) > gap) { segs.push(cur); cur = null; }
    if (!cur) cur = { x: w.x, x2: w.x + w.w, words: [], y: line.y };
    cur.words.push(w);
    cur.x2 = w.x + w.w;
  }
  if (cur) segs.push(cur);
  return segs.map((s) => ({ ...s, text: clean(s.words.map((w) => w.t).join(' ')), conf: Math.min(...s.words.map((w) => w.conf)) }));
}

/** Group segment start positions into columns (Sold To, Ship To, info). */
function columnsOf(segs, tol) {
  const xs = segs.map((s) => s.x).sort((a, b) => a - b);
  const groups = [];
  for (const x of xs) {
    const g = groups.find((gr) => Math.abs(gr.c - x) <= tol);
    if (g) { g.xs.push(x); g.c = g.xs.reduce((a, b) => a + b, 0) / g.xs.length; } else groups.push({ c: x, xs: [x] });
  }
  return groups.filter((g) => g.xs.length >= 2).sort((a, b) => a.c - b.c).map((g) => g.c);
}

const LABEL_RE = /^\W*([A-Z$5]{0,2}[O0Q]?L?D|S?H[I1Il]?P|SH[I1]P)\s*(T[O0]\s*:?|[O0]\s*:)\s*/;
const fixCompany = (s) => s.replace(/\bLL[GO6]\b/g, 'LLC').replace(/\bIN[GO]\b/g, 'INC').replace(/(\s+[—–\-|]+|\s+[A-Z]|\s+\W+)$/, '');

function parseAddressBlock(lines) {
  const out = { name: '', street: '', city: '', notes: [], phone: '' };
  const rest = [];
  for (const raw of lines) {
    const l = fixCompany(clean(UPPER(raw).replace(LABEL_RE, '')));
    const alnum = (l.match(/[A-Z0-9]/g) || []).length;
    if (!l || alnum < 3 || alnum / l.length < 0.5) continue;
    const ph = normPhone(l);
    if (ph && l.replace(PHONE, '').replace(/\W/g, '').length < 4) { out.phone ||= ph; continue; }
    rest.push(l);
  }
  for (const l of rest) {
    if (!out.street && /^\d+[A-Z]?\s+[A-Z0-9]/.test(l) && !/^\d{5}/.test(l) && !/^P\.?\s?O\.?\s/.test(l)) { out.street = l; continue; }
    if (out.street && !out.city && (STATE_RE.test(l) || /^[A-Z][A-Z .'-]+\s\d{5}(-\d{4})?$/.test(l))) { out.city = l; continue; }
    if (!out.street && !out.name) { if (/^(SHIP|SOLD|TO|SH[I1]P\s*T?[O0]?)\W*$/.test(l) || (l.match(/[A-Z]/g) || []).length < 3) continue; out.name = l; continue; }
    if (!out.street && /^P\.?\s?O\.?\s*BOX/.test(l)) { out.notes.push(l); continue; }
    if (!out.city) out.notes.push(l);
  }
  if (!out.city) {
    const c = rest.find((l) => STATE_RE.test(l) && l !== out.street);
    if (c) out.city = c;
  }
  return out;
}

/** Common OCR slips on street suffixes: OR→DR, RO→RD, 5T→ST, AVF→AVE. */
function fixStreet(st) {
  return st.replace(/\s(OR|0R|DF)$/, ' DR').replace(/\s(RO|R0|FD)$/, ' RD').replace(/\s(5T|S7|ST\.)$/, ' ST').replace(/\s(AVF|AV)$/, ' AVE').replace(/\s(LM|IN)$/, ' LN');
}

function formatCity(city) {
  const m = UPPER(city).match(new RegExp(`^(.*?)[\\s,]+(${STATES})\\b\\s*(\\d{5}(?:-\\d{4})?)?`));
  if (!m) {
    const z = UPPER(city).match(/^(.*?)\s+(\d{5}(?:-\d{4})?)$/);
    if (z) return `${clean(z[1])}, ${/^0[12]/.test(z[2]) ? 'MA' : 'CT'} ${z[2]}`.replace(/, (MA|CT) (06|01)/, (all, st, p) => `, ${p === '06' ? 'CT' : 'MA'} ${p}`);
    return clean(city);
  }
  return `${clean(m[1])}, ${m[2]}${m[3] ? ' ' + m[3] : ''}`;
}

function findDates(lines) {
  const found = [];
  for (const l of lines) {
    const re = /\b(\d{1,2})\s?\/\s?(\d{1,2})\s?\/\s?(\d{2,4})\b/g;
    let m;
    while ((m = re.exec(l.text))) {
      const after = l.text.slice(m.index + m[0].length, m.index + m[0].length + 8);
      const before = UPPER(l.text.slice(Math.max(0, m.index - 18), m.index));
      found.push({ mo: +m[1], d: +m[2], y: m[3], withTime: /^\s*\d{1,2}:\d{2}/.test(after), labelled: /DEL|EXPT|XPT|ATE\s*:|DATE/.test(before) && !/TIME/.test(before) });
    }
  }
  const cand = found.filter((f) => !f.withTime && f.mo >= 1 && f.mo <= 12 && f.d >= 1 && f.d <= 31);
  const pick = cand.find((f) => f.labelled) || cand[0];
  if (!pick) return { date: '', suspect: false };
  const now = new Date();
  let yy = pick.y.length === 2 ? 2000 + +pick.y : +pick.y;
  let suspect = false;
  if (Math.abs(yy - now.getFullYear()) > 1) { yy = now.getFullYear(); suspect = true; }
  const date = `${yy}-${String(pick.mo).padStart(2, '0')}-${String(pick.d).padStart(2, '0')}`;
  return { date, suspect };
}

// ------------------------------------------------------------------ line items

const NUM = /^[—–-]*\s*(\d*\.?\d+)$/;

/** Find qty / UM / SKU at the start of an item row. Works on word objects so we know where things sit. */
function splitUmSku(words, lineNoMaxX) {
  const parts = [];
  words.forEach((w, wi) => {
    const t = UPPER(w.t).replace(/[€£]/g, 'E').replace(/^G(A)(?=[|/\\\]\[}{Jjl!I])/, 'E$1');
    t.split(/[|\]\[}{]+/).forEach((p, pi) => { if (p) parts.push({ t: p, x: w.x, wi, glued: pi === 0 && t.length > p.length ? false : true }); });
  });
  // the unit, either on its own ("EA") or glued to the SKU by a misread column line ("EAJSODECK", "EAIFS")
  const umOf = (t) => {
    const m = UM_RE.exec(t);
    if (m) return { um: m[1], rest: t.slice(m[1].length).replace(/^[|/\\\]\[}{!]+/, '') };
    for (const um of ['EA', 'BX', 'LF', 'PC', 'SF', 'BF', 'BD', 'RL', 'SQ', 'BG', 'PR', 'CT', 'CS', 'PK', 'KT', 'ST']) {
      if (t.startsWith(um) && t.length >= um.length + 3 && /^[JLlI1|/\\!\]}]/.test(t.slice(um.length))) return { um, rest: t.slice(um.length + 1) };
    }
    return null;
  };
  // the unit can only come after line # / qty — never after a word
  let u = -1;
  for (let i = 0; i < parts.length && i <= 4; i++) {
    if (umOf(parts[i].t)) { u = i; break; }
    if (!/^[—–\-.\d,:;'`]*$/.test(parts[i].t)) break;
  }
  if (u === -1) return null;
  const { um, rest: glued } = umOf(parts[u].t);
  let rest = glued;
  let skuWi = parts[u].wi;
  if (rest) {
    // rest already has its separator removed
  } else if (parts[u + 1]) {
    rest = parts[u + 1].t.replace(/^[|/\\!]+/, '').replace(/^[JjlI|!](?=\d)/, '');
    skuWi = parts[u + 1].wi;
  }
  const nums = parts.slice(0, u).filter((p) => NUM.test(p.t));
  let qty = null, dashed = false;
  const pickNum = (p) => { const m = NUM.exec(p.t); qty = Number(m[1]); dashed = /^[—–-]/.test(p.t); };
  if (nums.length >= 2) pickNum(nums.at(-1));
  else if (nums.length === 1 && !(lineNoMaxX != null && nums[0].x < lineNoMaxX)) pickNum(nums[0]);
  return { qty, um, sku: rest.replace(/[^A-Z0-9\-\/.]/g, ''), dashed, skuWi };
}

function stripPriceTail(desc) {
  const PRICE = /\s+\(?-?\$?[\d,]+\.\d{2,3}\s*[/I|J]?\s*(EA|BX|LF|PC|SF|BF|BD|SQ|RL|BG|PR|CT|CS|GAL|LB|SH|KT|ST|PK|MBF)?\b.*$/;
  const hadPrice = PRICE.test(desc);
  let out = desc.replace(PRICE, '').replace(/\s+\d+(\.\d+)?\s*$/, '');
  // with the price gone, a trailing yard location (BAY1, J2, R2 SH, EC14) is left over
  if (hadPrice) out = out.replace(/\s+(BAY\s?\d+|[A-Z]{1,2}\s?\d{1,2}(\s+SH)?)\s*$/i, '');
  return clean(out);
}

const HEADER_WORDS = ['LINE', 'SHIPPED', 'ORDERED', 'SKU', 'DESCRIPTION', 'LOCATION', 'UNITS', 'PRICE', 'EXTENSION'];
const isHeaderLine = (t) => { const u = UPPER(t); return HEADER_WORDS.filter((k) => u.includes(k)).length >= 2; };

function parseItems(lines, imgW, noPositions) {
  const items = [], instructions = [];
  let hi = lines.findIndex((l) => isHeaderLine(l.text));
  if (hi === -1) return { items, instructions, foundHeader: false };
  const hdrWords = [];
  while (hi < lines.length && isHeaderLine(lines[hi].text)) { hdrWords.push(...lines[hi].words); hi++; }
  const find = (re) => hdrWords.find((w) => re.test(UPPER(w.t)));
  const shipped = find(/SHIPP/), ordered = find(/ORDER/), loc = find(/LOCAT/);
  const lineNoMaxX = noPositions ? null : shipped ? shipped.x : ordered ? ordered.x - imgW * 0.06 : null;
  const locX = noPositions ? null : loc ? loc.x - imgW * 0.006 : null;

  // a slanted photo can run two item rows together: split where a second "qty UM|SKU" starts mid-row
  const GLUED_UM = /^(EA|BX|LF|PC|SF|BF|BD|SQ|RL|BG|PR|CT|CS|PK|KT|ST)([|/\\\]}JLI1!]\S{2,})?$/;
  const split = [];
  for (let i = hi; i < lines.length; i++) {
    const l = lines[i];
    let cut = -1;
    for (let k = 3; k < l.words.length - 1; k++) {
      if (NUM.test(l.words[k - 1].t) && GLUED_UM.test(UPPER(l.words[k].t)) && (UPPER(l.words[k].t).length > 3 || /^[A-Z0-9]{3,}$/.test(UPPER(l.words[k + 1].t)))) { cut = k - 1; break; }
    }
    if (cut === -1) { split.push(l); continue; }
    const a = l.words.slice(0, cut), b = l.words.slice(cut);
    split.push({ ...l, words: a, text: a.map((w) => w.t).join(' ') }, { ...l, words: b, x: b[0].x, y: l.y + 0.1, text: b.map((w) => w.t).join(' ') });
  }
  lines = [...lines.slice(0, hi), ...split];

  let lastY = null;
  for (let i = hi; i < lines.length; i++) {
    const l = lines[i];
    const U = UPPER(l.text);
    if (FOOTER.test(U) || /^\W*\(\s*[A-Z]{2,}/.test(U)) break;
    if (isHeaderLine(l.text)) continue;
    const words = locX != null ? l.words.filter((w) => w.x < locX) : l.words;
    if (!words.length) continue;
    const conf = words.reduce((a, w) => a + w.conf, 0) / words.length;
    const r = splitUmSku(words, lineNoMaxX);
    if (r && r.sku && r.qty == null && locX != null) {
      // ordered qty didn't read: Chace prints the same count in the UNITS column
      const units = l.words.filter((w) => w.x >= locX).map((w) => w.t.replace(/[^\d.]/g, '')).find((t) => /^\d{1,4}$|^\d*\.\d$|^\d*\.50$/.test(t));
      if (units) r.qty = Number(units);
    }
    if (r && r.sku) {
      const desc = stripPriceTail(words.filter((w, wi) => wi > r.skuWi).map((w) => w.t).join(' '));
      items.push({ qty: r.qty, uom: r.um, sku: r.sku, desc, dashed: r.dashed, unsure: conf < 70 || r.qty == null || Math.min(...words.map((w) => w.conf)) < 40 });
      lastY = l.y;
      continue;
    }
    // a row whose qty/UM didn't survive OCR: SKU-looking first word that sits left of the description
    const lead = words.findIndex((w) => !(NUM.test(w.t) && lineNoMaxX != null && w.x < lineNoMaxX));
    const first = words[lead];
    if (!first) continue;
    const after = words.slice(lead + 1);
    const skuLike = /^[A-Z0-9][A-Z0-9\-\/.]{2,14}$/.test(UPPER(first.t)) && /\d/.test(first.t) && /[A-Z]/i.test(first.t);
    if (skuLike && after.length >= 2 && /\d\s*[X%]\s*\d|'|\bPT\b|KD|PLY|OSB/.test(UPPER(after.map((w) => w.t).join(' ')))) {
      items.push({ qty: null, uom: '', sku: UPPER(first.t), desc: stripPriceTail(after.map((w) => w.t).join(' ')), unsure: true });
      lastY = l.y;
      continue;
    }
    // text-only row: delivery instruction, special-order detail, or noise
    const d = UPPER(stripPriceTail(clean(words.map((w) => w.t).join(' '))));
    const letters = (d.match(/[A-Z]/g) || []).length;
    if (d.length < 4 || letters < 3 || letters / d.length < 0.45 || conf < 55) continue;
    if (BOILERPLATE.test(d)) continue;
    if (INSTRUCTION.test(d)) { instructions.push(d); continue; }
    const prev = items.at(-1);
    if (prev && /^SO/.test(prev.sku) && lastY != null && l.y - lastY < l.h * 3) { prev.desc = clean(`${prev.desc} ${d}`); lastY = l.y; }
  }
  // the same SKU read two ways on one ticket (e.g. SODECK / ISODECK): go with the majority
  const counts = new Map();
  for (const it of items) counts.set(it.sku, (counts.get(it.sku) || 0) + 1);
  const common = new Set([...counts].filter(([, n]) => n >= 2).map(([k]) => k));
  if (common.size) for (const it of items) if (!common.has(it.sku)) { const c = correctSku(it.sku, common); if (c.corrected) { it.sku = c.sku; } }
  return { items, instructions, foundHeader: true };
}

// ------------------------------------------------------------------ whole ticket

function parseLayout(words, imgW, known, noPositions = false) {
  let lines = toLines(words);
  // a second ticket peeking out underneath: start from the last letterhead on the page
  const lh = lines.map((l, i) => (/CHACE BUILDING|BUILDING SUPPLY OF|928-?\s?2747/.test(UPPER(l.text)) ? i : -1)).filter((i) => i >= 0);
  if (lh.length) {
    const firstLh = lh.find((i) => /CHACE|SUPPLY/.test(UPPER(lines[i].text))) ?? lh[0];
    const lastBlockStart = lh.filter((i) => i >= firstLh).reduce((acc, i) => (i - acc.prev > 6 ? { start: i, prev: i } : { start: acc.start, prev: i }), { start: firstLh, prev: firstLh }).start;
    if (lastBlockStart > 0) lines = lines.slice(lastBlockStart);
  }
  const result = { orderNo: '', customer: '', shipName: '', phone: '', address: '', date: '', instructions: '', lines: [], check: [] };

  // order number: "ORDER: 445328" / "SPEC ORDER: 441631" (never PURCHASE ORDER)
  const orderVotes = new Map();
  for (const l of lines) {
    const re = /(PURCHASE\s+)?ORDER\W{0,4}\s*([4-9]\d{5})\b/gi;
    let m;
    while ((m = re.exec(UPPER(l.text)))) if (!m[1]) orderVotes.set(m[2], (orderVotes.get(m[2]) || 0) + 1);
  }
  result.orderNo = [...orderVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';

  // header region: from the Sold To / Ship To labels down to the line-item header
  const itemHdr = lines.findIndex((l) => /SHIPPED|ORDERED|DESCRIPTION/.test(UPPER(l.text)));
  let start = lines.findIndex((l) => /SOLD|SH[I1]P\s*T[O0]/.test(UPPER(l.text)));
  if (start === -1) {
    const term = lines.findIndex((l) => /TERMINAL|TERMINA/.test(UPPER(l.text)));
    const cust = lines.findIndex((l) => /CUST|REFERENCE|PURCHASE/.test(UPPER(l.text)));
    start = term !== -1 ? term + 1 : cust !== -1 ? cust + 2 : 0;
  }
  const end = itemHdr === -1 ? Math.min(lines.length, start + 10) : itemHdr;
  const region = lines.slice(start, end);
  const segs = region.flatMap((l) => segments(l, imgW * 0.035));
  const cols = columnsOf(segs, imgW * 0.07);
  const colOf = (s) => cols.reduce((best, c, i) => (Math.abs(c - s.x) < Math.abs(cols[best] - s.x) ? i : best), 0);
  const sold = [], ship = [], info = [];
  if (!cols.length) sold.push(...segs);
  else {
    // assign word by word: a word belongs to the right-most column whose left edge it has passed
    const tol = imgW * 0.025;
    for (const l of region) {
      const buckets = [[], [], []];
      for (const w of l.words) {
        if (w.conf < 35 && w.t.replace(/\W/g, '').length <= 3 && !STATE_RE.test(UPPER(w.t)) && !/^\d+$/.test(w.t)) continue; // specks and table lines read as letters
        let c = 0;
        for (let k = 0; k < cols.length; k++) if (w.x >= cols[k] - tol) c = k;
        buckets[Math.min(c, 2)].push(w);
      }
      buckets.forEach((ws, k) => {
        if (!ws.length) return;
        const seg = { x: ws[0].x, words: ws, y: l.y, text: clean(ws.map((w) => w.t).join(' ')) };
        (k === 0 ? sold : k === 1 ? ship : info).push(seg);
      });
    }
  }
  // the info column holds salesperson, tax, dates and the big ORDER number — never address text
  const INFO_LABEL = /\s*(SALESP|SATESP|SALES TAX|TAX\s*:|TERMINAL|(SPEC\s+)?ORDER\s*:|EXPT|[DBP]E[LT]\.?\s*[DPCB]AT|ATE\s*:|PAGE NO).*$/i;
  const addrText = (arr) => arr.map((s) => clean(s.text.replace(INFO_LABEL, ''))).filter(Boolean);
  const soldB = parseAddressBlock(addrText(sold));
  const shipB = parseAddressBlock(addrText(ship));

  result.customer = soldB.name;
  result.shipName = shipB.name && !/^\d/.test(shipB.name) ? shipB.name : '';
  const street = fixStreet(shipB.street || '');
  const city = shipB.city || '';
  result.address = [street, city && formatCity(city)].filter(Boolean).join(', ');
  result.phone = shipB.phone || soldB.phone || '';
  const shipNotes = shipB.notes.filter((n) => !/^P\.?\s?O\.?\s*BOX/i.test(n) && INSTRUCTION.test(n));
  if (shipB.name && /^#/.test(shipB.name)) shipNotes.unshift(`Job: ${shipB.name}`);

  const dates = findDates(region.length ? lines.slice(0, end) : lines);
  result.date = dates.date;

  const it = parseItems(lines, imgW, noPositions);
  for (const raw of it.items) {
    const c = correctSku(raw.sku, known);
    result.lines.push({ qty: raw.qty, uom: raw.um || raw.uom, sku: c.sku, desc: raw.desc, unsure: raw.unsure || c.corrected, skuCorrected: c.corrected ? raw.sku : undefined, dashed: raw.dashed || undefined });
  }
  result.instructions = [...shipNotes, ...it.instructions].join(' / ');

  // what the dispatcher should double-check before saving
  if (!result.orderNo) result.check.push('order #');
  if (!result.customer) result.check.push('customer');
  if (!street) result.check.push('street address');
  if (!city) result.check.push('town / state');
  if (!result.date) result.check.push('delivery date');
  else if (dates.suspect) result.check.push('delivery date (year looked misread)');
  if (!result.lines.length) result.check.push('items — none were read');
  else if (result.lines.some((l) => l.unsure)) result.check.push('highlighted item lines');
  if (result.lines.some((l) => l.qty == null)) result.check.push('quantities');
  result._score = (result.orderNo ? 3 : 0) + (result.customer ? 1 : 0) + (street ? 2 : 0) + (city ? 2 : 0) + (result.date ? 1 : 0) + result.lines.length * 2 - result.lines.filter((l) => l.unsure).length;
  return result;
}

/** Text that came from somewhere other than our OCR (e.g. pasted from a phone's text recognition). */
function parseText(text, known) {
  // fake word positions: one word per token, one line per text line, no column info
  const words = [];
  text.split(/\r?\n/).forEach((line, li) => {
    let x = 0;
    for (const t of line.split(/\s+/).filter(Boolean)) { words.push({ t, x, y: li * 30, w: t.length * 10, h: 20, conf: 90, key: `p/${li}` }); x += t.length * 10 + 10; }
  });
  const res = parseLayout(words, 4000, known, true);
  // labels-based fallback for Ship To in pasted text (blocks come out one after another)
  const rows = text.split(/\r?\n/).map((r) => clean(r)).filter(Boolean);
  const si = rows.findIndex((r) => /^SH[I1]P\s*T[O0]/i.test(r));
  if (si !== -1 && !res.address) {
    const block = [];
    const first = clean(rows[si].replace(/^SH[I1]P\s*T[O0]\s*:?/i, ''));
    if (first) block.push(first);
    for (let i = si + 1; i < rows.length && block.length < 6; i++) {
      if (/^(SOLD|SALESP|DEL\.?|EXPT|ORDER|SPEC|LINE|TAX)/i.test(rows[i])) break;
      block.push(rows[i]);
    }
    const b = parseAddressBlock(block);
    res.shipName ||= b.name;
    res.address = [b.street, b.city && formatCity(b.city)].filter(Boolean).join(', ');
    res.phone ||= b.phone;
    res.check = res.check.filter((c) => !(b.street && c === 'street address') && !(b.city && c === 'town / state'));
  }
  const soldI = rows.findIndex((r) => /^SOLD\s*T[O0]/i.test(r));
  if (soldI !== -1 && si !== -1 && soldI !== si) {
    const sold = [];
    const first = clean(rows[soldI].replace(/SOLD\s*T[O0]\s*:?/i, ''));
    if (first) sold.push(first);
    for (let i = soldI + 1; i < rows.length && sold.length < 5 && i !== si; i++) {
      if (/^(SALESP|DEL\.?|EXPT|ORDER|SPEC|LINE|TAX)/i.test(rows[i])) break;
      sold.push(rows[i]);
    }
    const b = parseAddressBlock(sold);
    if (b.name) res.customer = b.name;
  } else if (soldI !== -1 && (!res.customer || /SH[I1]P\s*T[O0]/i.test(res.customer))) {
    res.customer = clean(rows[soldI].replace(/SOLD\s*T[O0]\s*:?/i, '').replace(/SH[I1]P\s*T[O0]\s*:?/i, '')) || rows[soldI + 1] || '';
  }
  return res;
}

// ------------------------------------------------------------------ combining the two OCR passes

const textScore = (s) => { const t = String(s || ''); if (!t) return -1; const good = (t.match(/[A-Z0-9 ,.&#'-]/gi) || []).length; return good / t.length * 10 + Math.min(t.length, 40) / 10; };
const addrScore = (a) => {
  if (!a) return -1;
  const [street, ...rest] = a.split(', ');
  const city = rest.join(', ');
  return (/^\d+[A-Z]?\s+[A-Z]{2,}(\s+[A-Z.]{2,})*$/.test(street) ? 4 : /^\d/.test(street) ? 1 : 0)
    + (new RegExp(`^[A-Z][A-Z .'-]+, (${STATES})`).test(city) ? 3 : 0) + (/\d{5}$/.test(city) ? 1 : 0) - ((a.match(/[^A-Z0-9 ,.#'&-]/gi) || []).length);
};
const itemsScore = (p) => p.lines.length * 3 - p.lines.filter((l) => l.unsure).length - p.lines.filter((l) => l.qty == null).length;

function mergeParses(parses) {
  if (parses.length === 1) { delete parses[0]._score; return parses[0]; }
  const by = (fn) => [...parses].sort((a, b) => fn(b) - fn(a))[0];
  const vote = (k) => {
    const m = new Map();
    for (const p of parses) if (p[k]) m.set(p[k], (m.get(p[k]) || 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  };
  const itemsFrom = by(itemsScore);
  const addrFrom = by((p) => addrScore(p.address));
  const out = {
    orderNo: vote('orderNo'),
    customer: by((p) => textScore(p.customer)).customer,
    shipName: addrFrom.shipName,
    phone: vote('phone'),
    address: addrFrom.address,
    date: by((p) => (p.date ? 1 : 0) + (p.check.some((c) => /year/.test(c)) ? -0.5 : 0)).date,
    instructions: by((p) => (p.instructions ? p.instructions.split(' / ').filter((x) => INSTRUCTION.test(x)).length : -1)).instructions,
    lines: itemsFrom.lines,
  };
  const dateSuspect = parses.every((p) => !p.date || p.check.some((c) => /year/.test(c)));
  out.check = [];
  if (!out.orderNo) out.check.push('order #');
  if (!out.customer) out.check.push('customer');
  if (addrScore(out.address) < 7) out.check.push('delivery address');
  if (!out.date) out.check.push('delivery date');
  else if (dateSuspect) out.check.push('delivery date (year looked misread)');
  if (!out.lines.length) out.check.push('items — none were read');
  else if (out.lines.some((l) => l.unsure)) out.check.push('highlighted item lines');
  if (out.lines.some((l) => l.qty == null)) out.check.push('quantities');
  return out;
}

// ------------------------------------------------------------------ entry point

// ImageMagick 7 (Alpine) uses `magick`; older installs use `convert` / `identify`
let IM;
async function imageMagick() {
  if (IM !== undefined) return IM;
  for (const c of [{ conv: ['magick'], ident: ['magick', 'identify'] }, { conv: ['convert'], ident: ['identify'] }]) {
    try { await run(c.conv[0], ['-version']); IM = c; return IM; } catch {}
  }
  IM = null;
  return IM;
}

async function readTicket(buf, mediaType, { knownSkus } = {}) {
  if (mediaType === 'application/pdf') throw new Error('PDFs can\'t be read yet — take a photo or screenshot of the ticket instead.');
  const known = new Set([...(knownSkus || [])].map(UPPER));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-'));
  try {
    const src = path.join(dir, 'in.img');
    fs.writeFileSync(src, buf);
    let imgW = 1600;
    const variants = [src];
    const im = await imageMagick();
    const scales = [1];
    if (im) {
      // straighten from the phone's rotation tag and bring the long side to ~2200-3000px, which Tesseract reads best
      const base = path.join(dir, 'base.png');
      try {
        const [w, h, orient] = (await run(im.ident[0], [...im.ident.slice(1), '-format', '%w %h %[orientation]', src + '[0]'])).trim().split(' ');
        imgW = Number(w) || imgW;
        const long = Math.max(Number(w), Number(h));
        const geo = long > 3000 ? ['-resize', '3000x3000>'] : long < 1600 ? ['-resize', '2200x2200<'] : [];
        if (geo.length || (orient && !/TopLeft|Undefined/i.test(orient))) {
          // only re-save when needed (rotation tag or size); keep color — Tesseract does its own thresholding
          await run(im.conv[0], [...im.conv.slice(1), src + '[0]', '-auto-orient', ...geo, base]);
          imgW = Number((await run(im.ident[0], [...im.ident.slice(1), '-format', '%w', base])).trim()) || imgW;
          variants[0] = base;
        }
      } catch {}
      const lat = path.join(dir, 'lat.pgm');
      try {
        await run(im.conv[0], [...im.conv.slice(1), variants[0] + (variants[0] === src ? '[0]' : ''), '-auto-orient', '-colorspace', 'Gray', '-resize', '150%', '-lat', '40x40-8%', lat]);
        variants.push(lat);
        scales.push(1.5);
      } catch {}
    }
    const parses = [];
    let rawText = '';
    for (let vi = 0; vi < variants.length; vi++) {
      const words = await ocrWords(variants[vi]);
      parses.push(parseLayout(words, imgW * scales[vi], known));
      if (vi === 0) rawText = toLines(words).map((l) => l.text).join('\n');
    }
    let best = mergeParses(parses);
    // hard photo (glare, angle, another sheet underneath): one more pass reading the page as a single block
    if (best.check.some((c) => /address|date|items/.test(c))) {
      parses.push(parseLayout(await ocrWords(variants.at(-1), 6), imgW * scales.at(-1), known));
      best = mergeParses(parses);
    }
    return { parsed: best, rawText, engine: 'local' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { readTicket, parseText, parseLayout, correctSku };
