# Dispatch

A self-hosted dispatch board for a building supply yard. Import the day's Epicor order tickets, let the app work out what each order needs and propose loads for every truck, then you check, adjust and accept. You stay the final say on what leaves the yard.

## The daily flow

1. **Import tickets.** Drop in photos or PDFs of the printed Epicor tickets (on a phone, this opens the camera), or a CSV export if you can get one. The app reads the order #, customer, phone, delivery address, date, instructions, and every line item.
2. **Review.** Each ticket opens next to its photo, so you can fix anything misread. Unknown items are highlighted; teach them once (see Translator).
3. **Auto-plan day.** The app proposes a truck, trip, and stop order for every unconfirmed order:
   - only trucks with the right equipment (boom, Moffett, covered) and enough deck for the longest item
   - stops grouped by drive distance from the yard, as round trips
   - rush orders first, on each truck's first trip
   - boom and box trucks kept free for the jobs that need them, and work spread across trucks
   - stops-per-trip and trips-per-day limits for each truck
   Each proposed card says why it went there ("only Boom 1 has boom · ~4.8 mi from Smith Builders"). Orders that can't go anywhere stay in Unassigned with the reason.
4. **Adjust and accept.** Drag anything you'd do differently; your moves count as confirmed. Then **Accept** per truck or **Accept all**. Re-running Auto-plan only touches orders you haven't confirmed.
5. **Print run sheets** per truck (stops, items, instructions, and a signature column).

The **Routes** map sits in the corner and shows assigned loads. Click it, or click a truck's name, to expand it and see each truck's routes.

## Translator

The translator turns Epicor SKUs and counter shorthand into what matters for a truck:

- **What it is** — plain words ("Architectural shingles").
- **Length** — read automatically from lumber descriptions (`2X10X16`, `2X4-8`, `1-3/4X11-7/8X24 LVL`, `4X12 drywall`, `16'`, precut studs in inches), or set it per item.
- **Needs boom / Moffett / covered truck.**
- **Not freight** — delivery charges, fees, notes.

Rules can match an exact SKU, SKUs starting with a prefix, or any line containing some text. **Ticket phrase** rules match the delivery instructions, so something like "ROOF LOAD" can mean the order needs the boom. Every rule applies to all past and future tickets. The Translator button shows how many items on the current day still need teaching.

On any order you can override the needs (Boom / Moffett / Covered / longest item) if this particular delivery is different.

## Reading ticket photos

Settings → **Ticket reader**:

- **Claude API** (recommended). Most reliable on phone photos. Needs an API key from console.anthropic.com, and each ticket costs a few cents. The photo is sent to Anthropic to be read.
- **Local OCR** (Tesseract, built into the Docker image). Free, and nothing leaves your server. Works on clean, flat, well-lit photos, but expect to fix lines more often.
- **Automatic** uses Claude when a key is set, and local OCR otherwise.

Ticket photos are kept with the order; click the ticket icon on a card to see it.

## Run it

### Portainer (stack from this repo)

1. **Stacks → Add stack → Repository**, URL `https://github.com/wunderslug/dispatch-app`, compose path `docker-compose.yml` (for a private repo, use a GitHub personal access token).
2. Deploy, then open `http://<server>:32799`.

To update later, use **Pull and redeploy** on the stack. Data lives in the `dispatch-data` volume and survives redeploys.

### Docker Compose on the host

```bash
git clone https://github.com/wunderslug/dispatch-app && cd dispatch-app
docker compose up -d --build
```

### Without Docker

Needs Node 20+ (no npm dependencies). For local OCR, also install `tesseract`.

```bash
node server.js     # http://localhost:8080, data in ./data
```

## First-time setup

1. **Settings** — company name, yard address, ticket reader (and API key).
2. **Trucks** — for each truck: badge code and color, type, driver, deck length, stops per trip, trips per day, and whether it has a boom, a Moffett, or a covered body. Uncheck **On board** for a truck that's down.
3. Import a stack of tickets and **teach the translator** the items it doesn't know. It gets faster every day.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port inside the container (published as 32799) |
| `DATA_DIR` | `/data` | Database (`db.json`) and ticket images |
| `ANTHROPIC_API_KEY` | — | Claude key for reading tickets (or set it in Settings) |
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | Model used to read tickets |
| `GEOCODE_EMAIL` | — | Contact email sent to Nominatim, per its usage policy |
| `GEOCODE_COUNTRIES` | `us` | Limit address lookup to these countries |
| `NOMINATIM_URL` / `OSRM_URL` / `TILE_URL` | public OpenStreetMap / OSRM / CARTO dark | Address lookup, driving routes, map tiles |

Addresses are located automatically in the background (one per second, per Nominatim's rules). Planning uses straight-line distance with a road factor; the map and trip headers show real driving routes.

## Backups

Settings → **Download backup** saves trucks, orders, translator rules and settings (not the API key) as one JSON file. Ticket images live in `/data/tickets`.

## How it's built

- `server.js` — Node HTTP server, JSON-file storage, background geocoding, routing proxy, planning endpoint.
- `ticket-reader.js` — Claude vision or local Tesseract, producing the same structured order.
- `public/shared.js` — translator, length parsing, order requirements, and the planner (used by both server and browser).
- `public/` — the board: plain HTML/CSS/JS styled to the Dispatch UI Kit, with Leaflet and Inter bundled. No build step.

There's no login. Keep it on your internal network, or put it behind a reverse proxy with authentication.
