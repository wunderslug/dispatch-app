# Dispatch

A small, fast lumberyard delivery-time calculator and live truck-status display.

## Core goal

Dispatch does **not** decide how to dispatch trucks. It gives the dispatcher a credible estimate of when a truck should return, then keeps that estimate visible and synchronized across devices.

## V1 workflow

1. Enter a delivery destination.
2. Choose a truck type.
3. Choose load size: Small, Medium, or Large.
4. Start time defaults to the current time and can be changed.
5. Optionally add extra minutes for known delays or unusual conditions.
6. Calculate the estimated round-trip truck time and return time.
7. Save the calculation as a current run.
8. Current runs synchronize live across phone and desktop.
9. Mark a run Returned when the truck is back.

## Calculation

`outbound drive + on-site allowance + return drive + optional extra time = estimated truck time`

On-site allowances are configurable by truck type and load size.

## Main UI

### Calculator
- Destination
- Truck type
- Load size
- Start time (`Now` by default; editable)
- Optional extra minutes
- Calculate

### Result
The return time is the dominant information, followed by total duration and a compact breakdown of outbound drive, on-site allowance, return drive, and extra time.

### Current Runs
A simple live list intended for a larger desktop display:

| Truck | Destination | Left | Est. Return |
| --- | --- | --- | --- |
| Moffett | Ashford | 9:10 AM | 10:42 AM |

This is intentionally not a dispatch board. It is shared situational awareness.

## UI direction

Mobile-first with a restrained blend of Material structure and iOS-style translucency:
- clear hierarchy
- large touch targets
- frosted/translucent surfaces
- subtle depth and borders
- rounded controls without excessive rounding
- fast, low-clutter interaction
- responsive large-screen Current Runs display

## Architecture

The calculation logic belongs behind an API rather than inside a single UI so multiple interfaces can use the same system.

```text
Phone web app ─┐
Desktop web app ├── Dispatch API ── Calculation engine ── Routing provider
Future voice UI ┘       │
                        └── Shared live state
```

This leaves room for future Alexa/voice input without redesigning the calculation engine.

## Planned components

- Web UI / PWA
- Dispatch API
- Shared current-run storage
- Real-time synchronization
- Routing provider adapter
- Configurable truck/load handling allowances
- Settings for yard/base address

## Explicitly out of scope for V1

- automatic truck assignment
- route optimization across multiple trucks
- fleet management
- driver tracking
- complex scheduling
- TMS/ERP functionality
- Alexa integration (architecture should permit it later)

The project should remain small unless real-world use proves another feature is necessary.
