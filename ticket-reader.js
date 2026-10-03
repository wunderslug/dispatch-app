// Reads a photo (or PDF) of an Epicor order ticket into structured order data.
// Two engines:
//   claude    — Claude API vision; best accuracy, needs an API key, image leaves your server
//   tesseract — local OCR + pattern matching; free and private, needs review more often

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_URL = process.env.CLAUDE_API_URL || 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';

const PROMPT = `This is a delivery order ticket printed from a building supply / lumberyard POS (Epicor).
Read it exactly as printed. Do not translate abbreviations or SKUs — copy them character for character.

Return ONLY a JSON object, no commentary, with this shape:
{
  "orderNo": "order / ticket / invoice number as printed, or null",
  "customer": "customer or sold-to name, or null",
  "phone": "contact phone, or null",
  "deliveryAddress": "ship-to / job site / delivery address on one line (street, town, state, zip), or null",
  "deliveryDate": "requested delivery date as YYYY-MM-DD, or null",
  "instructions": "delivery instructions, special instructions or notes printed on the ticket, or null",
  "lines": [ { "qty": number or null, "uom": "unit as printed or null", "sku": "item number/SKU as printed or null", "desc": "item description as printed" } ]
}
Include every product line. Skip subtotal, tax, payment and signature lines. If a line is a delivery/fuel charge, include it anyway.`;

function cleanParsed(p) {
  const s = (v) => (v === null || v === undefined ? '' : String(v).trim());
  const lines = Array.isArray(p.lines) ? p.lines : [];
  return {
    orderNo: s(p.orderNo),
    customer: s(p.customer),
    phone: s(p.phone),
    address: s(p.deliveryAddress || p.address),
    date: /^\d{4}-\d{2}-\d{2}$/.test(s(p.deliveryDate)) ? s(p.deliveryDate) : '',
    instructions: s(p.instructions),
    lines: lines
      .map((l) => ({ qty: Number.isFinite(Number(l.qty)) && l.qty !== null && l.qty !== '' ? Number(l.qty) : null, uom: s(l.uom), sku: s(l.sku), desc: s(l.desc || l.description) }))
      .filter((l) => l.sku || l.desc),
  };
}

async function readWithClaude(buf, mediaType, apiKey) {
  const isPdf = mediaType === 'application/pdf';
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: [
        { type: isPdf ? 'document' : 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } },
        { type: 'text', text: PROMPT },
      ],
    }],
  };
  const r = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${data?.error?.message || 'request failed'}`);
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let parsed;
  try { parsed = JSON.parse(json); } catch { throw new Error('Could not understand the ticket reader response'); }
  return { parsed: cleanParsed(parsed), rawText: '' };
}

function runTesseract(file) {
  return new Promise((resolve, reject) => {
    execFile('tesseract', [file, 'stdout', '--psm', '4'], { maxBuffer: 10 * 1024 * 1024, timeout: 90000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(err.code === 'ENOENT' ? 'Tesseract is not installed' : `OCR failed: ${stderr || err.message}`));
      resolve(stdout);
    });
  });
}

const UOM = '(EA|PC|PCS|BD|BF|LF|SF|BDL|BNDL|BUN|SQ|SHT|SH|BAG|BG|BX|BOX|RL|ROLL|LB|UN|UNIT|GAL|PR|SET|CTN|CS|PAIL|TUBE|KIT|PLT|PALLET|LOT)';
const LINE_QTY_FIRST = new RegExp(`^\\s*(\\d+(?:\\.\\d+)?)\\s+(?:${UOM}\\s+)?([A-Z0-9][A-Z0-9\\-\\/\\.]{2,})\\s+(.+?)\\s*$`, 'i');
const LINE_SKU_FIRST = new RegExp(`^\\s*([A-Z0-9][A-Z0-9\\-\\/\\.]{2,})\\s+(.+?)\\s+(\\d+(?:\\.\\d+)?)\\s+(?:[^\\sA-Z]{1,3}\\d?\\s+)?${UOM}\\b`, 'i');
const PRICE_TAIL = /\s+\$?-?[\d,]+\.\d{2,4}(\s+\$?-?[\d,]+\.\d{2})*\s*[A-Z]?\s*$/;
const STREET = /^\s*\d+[A-Z]?\s+.*\b(ST|STREET|RD|ROAD|AVE|AVENUE|LN|LANE|DR|DRIVE|WAY|HWY|HIGHWAY|ROUTE|RTE|RT|TPKE|TURNPIKE|CT|COURT|PL|PLACE|BLVD|CIR|CIRCLE|TER|TERRACE|PIKE|TRL|TRAIL|EXT|HILL)\b\.?/i;
const CITY_ZIP = /\b[A-Z][A-Za-z .'-]+,?\s+[A-Z]{2}\s+\d{5}(-\d{4})?\b/;

/** Best-effort pull of order fields out of raw OCR text. The review screen fixes the rest. */
function parseOcrText(text) {
  const rows = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const all = rows.join('\n');
  const after = (re, n = 1) => {
    const i = rows.findIndex((r) => re.test(r));
    if (i === -1) return [];
    const same = rows[i].replace(re, '').replace(/^[\s:#-]+/, '').trim();
    return [same, ...rows.slice(i + 1, i + 1 + n)].filter(Boolean);
  };

  const orderNo = (all.match(/(?:ORDER|INVOICE|TICKET|TRANSACTION|TRANS|SALES ORDER|SO)\s*(?:#|NO\.?|NUMBER)?\s*[:#]?\s*([A-Z]{0,3}\d[\dA-Z-]{3,})/i) || [])[1] || '';
  const phone = (all.match(/\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/) || [])[0] || '';
  const customer = after(/^(SOLD TO|CUSTOMER|BILL TO|ACCOUNT)\b[:\s]*/i)[0] || '';

  let address = '';
  const shipBlock = after(/^(SHIP TO|DELIVER TO|DELIVERY ADDRESS|JOB ?SITE|JOB ADDRESS|SHIP-TO)\b[:\s]*/i, 3);
  const pickAddr = (block) => {
    const si = block.findIndex((r) => STREET.test(r));
    if (si === -1) return '';
    const cz = block.slice(si + 1, si + 3).find((r) => CITY_ZIP.test(r));
    return [block[si], cz].filter(Boolean).join(', ');
  };
  address = pickAddr(shipBlock) || pickAddr(rows);

  let date = '';
  const dm = all.match(/(?:DELIVERY|DELIVER|DEL|SHIP|REQ(?:UESTED)?|DUE)\s*(?:DATE)?\s*:?\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i);
  if (dm) {
    const y = dm[3].length === 2 ? '20' + dm[3] : dm[3];
    date = `${y}-${dm[1].padStart(2, '0')}-${dm[2].padStart(2, '0')}`;
  }

  const instructions = rows.filter((r) => /INSTRUCTION|SPECIAL|DEL(IVERY)? NOTE|NOTES?:|COMMENT/i.test(r))
    .map((r) => r.replace(/^.*?(INSTRUCTIONS?|NOTES?|COMMENTS?)\s*:?\s*/i, '')).filter(Boolean).join(' / ');

  const lines = [];
  for (const raw of rows) {
    const r = raw.replace(PRICE_TAIL, '');
    if (/SUBTOTAL|TOTAL|TAX|BALANCE|PAYMENT|SIGNATURE|CHANGE DUE|TENDER/i.test(r)) continue;
    let m = r.match(LINE_SKU_FIRST);
    if (m && !/^(ITEM|SKU|PRODUCT)$/i.test(m[1])) { lines.push({ qty: Number(m[3]), uom: m[4].toUpperCase(), sku: m[1], desc: m[2] }); continue; }
    m = r.match(LINE_QTY_FIRST);
    if (m && /\d/.test(m[3]) && m[4].length > 2) lines.push({ qty: Number(m[1]), uom: (m[2] || '').toUpperCase(), sku: m[3], desc: m[4] });
  }
  return { orderNo, customer, phone, address, date, instructions, lines };
}

async function readWithTesseract(buf, mediaType) {
  if (mediaType === 'application/pdf') throw new Error('PDF tickets need the Claude reader. Take a photo or screenshot instead.');
  const tmp = path.join(os.tmpdir(), `ticket-${Date.now()}-${Math.random().toString(36).slice(2)}.img`);
  fs.writeFileSync(tmp, buf);
  try {
    const text = await runTesseract(tmp);
    const p = parseOcrText(text);
    return { parsed: cleanParsed({ ...p, deliveryAddress: p.address, deliveryDate: p.date }), rawText: text };
  } finally { fs.rmSync(tmp, { force: true }); }
}

async function readTicket(buf, mediaType, { engine, apiKey }) {
  const use = engine === 'claude' || (engine !== 'tesseract' && apiKey) ? 'claude' : 'tesseract';
  if (use === 'claude' && !apiKey) throw new Error('No Claude API key set. Add one in Settings, or switch the reader to Local OCR.');
  const out = use === 'claude' ? await readWithClaude(buf, mediaType, apiKey) : await readWithTesseract(buf, mediaType);
  return { ...out, engine: use };
}

module.exports = { readTicket, parseOcrText };
