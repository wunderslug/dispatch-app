# Dispatch

A self-hosted dispatch board for a building supply yard. Import the day's Epicor order tickets, let the app work out what each order needs and propose loads for every truck, then you check, adjust and accept. You stay the final say on what leaves the yard.

## The daily flow

1. **Import tickets.** Drop in photos of the printed Epicor tickets (on a phone, this opens the camera), paste text copied off a ticket with your phone, or import a CSV. The app reads the order #, customer, ship-to, phone, delivery address, date, instructions, and every line item, and tells you what to double-check.
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

## Call reminders

Ticket notes like "call before leaving yard", "call when en route", "call ahead", "call on arrival" or "call the day before" are picked up on import, and so are variations like "call B4 you leave", "text Mike when headed over", or "call Joe 30 min before". You can also set one by hand in any order (for when a salesman tells you instead of writing it down), with the number to call and a note.

- The **Calls** button opens a sidebar with every call for the day: customer, tap-to-call number, truck/trip/stop, and a **Called** checkbox that records the time.
- Each trip has a **Mark loaded** button. When you mark a trip loaded, its "before leaving" and "en route" calls move to **Call now**, the Calls count turns red, and the sidebar opens.
- "Call the day before" reminders for tomorrow's orders show on today's board.
- Cards on the board show a phone tag: grey until due, red when due, green once called.

## Translator

The translator turns Epicor SKUs and counter shorthand into what matters for a truck:

- **What it is** — plain words ("Architectural shingles").
- **Length** — read automatically from lumber descriptions (`2X10X16`, `2X4-8`, `1-3/4X11-7/8X24 LVL`, `4X12 drywall`, `16'`, precut studs in inches), or set it per item.
- **Needs boom / Moffett / covered truck.**
- **Not freight** — delivery charges, fees, notes.

Rules can match an exact SKU, SKUs starting with a prefix, or any line containing some text. **Ticket phrase** rules match the delivery instructions, so something like "ROOF LOAD" can mean the order needs the boom. Every rule applies to all past and future tickets. The Translator button shows how many items on the current day still need teaching.

On any order you can override the needs (Boom / Moffett / Covered / longest item) if this particular delivery is different.

## Reading ticket photos

Free and local. Nothing leaves your server and nothing costs per ticket.

- ImageMagick straightens and cleans each photo, and Tesseract OCR reads it. The reader knows the Chace/Epicor ticket layout: it uses where words sit on the page to separate Sold To from Ship To, and anchors item rows on the unit and SKU columns.
- Each photo is read three ways: as taken, with shadows evened out, and with red ink removed (so the dispatcher's red pen marks and notes don't garble the print). Each field comes from whichever read looks right. A third pass runs only when a photo is hard to read.
- The review screen shows the photo next to what was read. Item rows read with low confidence are highlighted, and a **Double-check** line lists what to verify (missing qty, a misread year, an address that didn't parse, a ticket date that's already past).
- **SKUs you've confirmed fix future misreads.** Once `13S16` has been saved on an order, a later `13816` is matched to it automatically.
- **Paste ticket text:** if a photo reads badly, copy the text with your phone (iPhone Live Text, or Google Lens → Text) and paste it into the Import screen. It goes through the same parser.

For the best read: one ticket per photo, flat and unfolded, phone straight above it, the whole ticket in frame, no shadow across it. Handwritten notes aren't read; add them to the order's notes.

Tested on six real Chace tickets: flat, straight-on photos read correctly apart from the occasional misread digit, which the review screen flags. Folded, angled, or overlapping photos read poorly.

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

1. **Settings** — company name and yard address.
2. **Trucks** — for each truck: badge code and color, type, driver, deck length, stops per trip, trips per day, and whether it has a boom, a Moffett, or a covered body. Uncheck **On board** for a truck that's down.
3. Import a stack of tickets and **teach the translator** the items it doesn't know. It gets faster every day.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port inside the container (published as 32799) |
| `DATA_DIR` | `/data` | Database (`db.json`) and ticket images |
| `GEOCODE_EMAIL` | — | Contact email sent to Nominatim, per its usage policy |
| `GEOCODE_COUNTRIES` | `us` | Limit address lookup to these countries |
| `NOMINATIM_URL` / `OSRM_URL` / `TILE_URL` | public OpenStreetMap / OSRM / CARTO dark | Address lookup, driving routes, map tiles |

Addresses are located automatically in the background (one per second, per Nominatim's rules). Planning uses straight-line distance with a road factor; the map and trip headers show real driving routes.

## Backups

Settings → **Download backup** saves trucks, orders, translator rules and settings as one JSON file. Ticket images live in `/data/tickets`.

## How it's built

- `server.js` — Node HTTP server, JSON-file storage, background geocoding, routing proxy, planning endpoint.
- `ticket-reader.js` — local ticket reader: ImageMagick + Tesseract, plus the Chace/Epicor layout parser (also used for pasted text).
- `public/shared.js` — translator, length parsing, order requirements, and the planner (used by both server and browser).
- `public/` — the board: plain HTML/CSS/JS styled to the Dispatch UI Kit, with Leaflet and Inter bundled. No build step.

There's no login. Keep it on your internal network, or put it behind a reverse proxy with authentication.
