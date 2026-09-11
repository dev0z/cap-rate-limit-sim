# CAP in Practice — Distributed Rate Limiting

An interactive simulation of the CAP theorem through a problem CDNs solve every day: enforcing one global
rate limit across many edge nodes. Four edge servers, one central store, a 200 ms simulation tick.
Switch between eventual and strong consistency, tune the gossip interval, cut a link, and watch what the
system gets wrong or refuses to do.

Live: https://cap-rate-limit-sim-1.vercel.app/

## What to try

1. Leave it in **Eventual (AP)** at 300 req/s per node. The store reads above 1,000: every node decides
   from a stale view of the others.
2. Drag **Gossip interval** from 2 s down to 200 ms. The overshoot shrinks but never disappears.
3. Switch to **Strong (CP)**. Exactly 1,000, and every decision now costs a round trip to Virginia.
4. Cut Tokyo's wire in CP: it fails closed and availability drops to 75 %. Cut it in AP: it keeps serving
   blind and the Debt ledger climbs. Heal it to see the bill.
5. Switch the scenario to **Ticket sale** for the same trade-off with 1,000 seats instead of a rate. Sales
   run as repeated drops; the log at the bottom of the stage compares how many seats each mode sold.

New here? The first visit opens a short intro ("What is CAP?" in the header brings it back), and the
guided tour spotlights each control while it changes the settings. "Auto-play it" runs the whole tour.

The Scenarios chips set up seven situations (calm, max traffic, flash crowd, fast and slow gossip, a quiet
partition, a partition storm); hover a chip for what to watch. The "Same traffic, three strategies" panel
runs the other two modes on identical traffic so you can compare without switching. Every situation is in
the URL; the share button copies a link to it, e.g. `?m=cp&r=400&cut=3`.

## Run

```bash
npm install
npm run dev
```

## Test and build

```bash
npm test
npm run build
```

Tests cover the simulation engine only (determinism, conservation, limit invariants, partition behavior).

## Deploy

Import the GitHub repo in the Vercel dashboard; `vercel.json` sets the Vite build and security headers.

## Docs

- `PLAN.md` — scope, milestones, what shipped.
- `DESIGN.md` — the simulation model, formulas, calibration numbers, and decision log.
