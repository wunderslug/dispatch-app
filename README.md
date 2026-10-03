# Dispatch

A self-hosted dispatch board for a building supply yard's delivery trucks. One dispatcher, one screen: drag the day's orders onto trucks, see each truck's routes on a map, and get flagged when a load won't fit the truck.

## What it does

- **Daily board.** An Unassigned column plus one column per truck. Drag orders onto a truck and into the stop order you want. Trucks can run several trips a day; drop an order on "+ Drop here for another trip" to start one.
- **Fit checks.** Each truck has a payload limit, deck length, and whether it has a boom or a Moffett. The board flags:
  - trips over payload (with a load bar per trip)
  - material longer than the deck
  - orders that need a boom or Moffett on a truck without one
  - orders whose address hasn't been located on the map
- **Map and routes.** Stops are numbered pins in each truck's color. Each trip is drawn as a real driving route from the yard, through the stops, and back, with miles and drive time on the trip header and per-stop drive time on each card. Click a truck's header to focus it on the map; click a legend entry to hide a truck.
- **Re-order stops.** The ⇅ button on a trip sorts its stops into the shortest loop from the yard.
- **Run sheets.** The ⎙ button on a truck prints its stops for the driver: customer, phone, address, delivery window, materials, notes, weight, and a signature column.
- **Day tools.** Move the day's undelivered orders to tomorrow, and download or restore a full backup (Settings).

Keyboard: `n` new order, `Enter` edit the selected order, `Esc` clear focus, `Alt+←/→` change day.

## Run it

### Portainer (stack from this repo)

1. **Stacks → Add stack → Repository.**
2. Repository URL: `https://github.com/wunderslug/dispatch-app`, compose path `docker-compose.yml`. If the repo is private, turn on authentication and use a GitHub personal access token.
3. Deploy, then open `http://<server>:8080`.

### Docker Compose on the host

```bash
git clone https://github.com/wunderslug/dispatch-app
cd dispatch-app
docker compose up -d --build
```

### Without Docker

Needs Node 20 or newer; there are no npm dependencies.

```bash
node server.js            # http://localhost:8080, data in ./data/db.json
```

## First-time setup

1. **Settings →** enter the company name and the yard address (Find, or Pin on map). Routes start and end at the yard.
2. **Trucks →** add each truck with its type, driver, payload (lb), deck length (ft), and whether it has a boom or Moffett. Uncheck "On board" to hide a truck that's down for the day.
3. **+ Order →** customer, address, weight, longest item, delivery window, boom/Moffett needs, materials and driver notes.

## Configuration

Environment variables (all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `DATA_DIR` | `./data` (`/data` in Docker) | Where `db.json` lives |
| `GEOCODE_EMAIL` | empty | Contact email sent to Nominatim, per its usage policy |
| `GEOCODE_COUNTRIES` | `us` | Limit address search to these countries |
| `NOMINATIM_URL` | public OpenStreetMap Nominatim | Address lookup service |
| `OSRM_URL` | public OSRM demo server | Driving routes |
| `TILE_URL` | OpenStreetMap tiles | Map tiles |

Address lookup, routing and map tiles use free public OpenStreetMap services, which is plenty for one dispatcher. Routes are car routes, so treat drive times as an estimate for a loaded truck. If you outgrow the public services, point the URLs above at your own Nominatim/OSRM containers.

## Data and backups

Everything is stored in one JSON file (`/data/db.json` in the `dispatch-data` volume). Settings → **Download backup** saves a copy; **Restore from backup** replaces everything with a saved copy.

## How it's built

- `server.js` — Node HTTP server with no dependencies: JSON API, JSON-file storage, and proxies for geocoding and routing (with caching and Nominatim's 1 request/second limit).
- `public/` — the board: plain HTML, CSS and JavaScript, with Leaflet bundled for the map. No build step.

There's no login. Run it on your internal network, or put it behind a reverse proxy with authentication if it needs to be reachable from outside.
