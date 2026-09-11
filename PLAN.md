# Plan — CAP in Practice: Distributed Rate Limiting

Source of truth for scope and status. `DESIGN.md` holds the model and the decision log.

## Goal

A hosted, single-file React simulation that teaches the CAP theorem through distributed rate limiting
across CDN edge nodes. The audience has never heard of CAP. Within a minute of play they should discover:

1. Fast local decisions (AP) let the global limit be violated.
2. Syncing more often shrinks the violation but never removes it (four nodes fill the same budget at once).
3. Strong consistency (CP) is exact, but every request pays a round trip.
4. When the network breaks you must choose: keep serving and be wrong, or stop serving and be right.

## Constraints

- 200 ms simulation tick driven by `useEffect`; 4 edge nodes; per-node traffic slider 0–500 req/s;
  strict global limit 1000 req/s; gossip-interval slider.
- Single-file component `src/CapSimulator.tsx` (engine + UI). Tailwind v4, lucide-react, inline SVG charts.
- Pure frontend, deployed on Vercel from GitHub. Total effort budget ~2 hours.
- Tests cover only simulation correctness. Comments small and precise.

## Decisions

- Traffic slider is per-node mean (total up to 2000 vs the 1000 limit). Default 300.
- Gossip slider is 200–2000 ms in 200 ms steps: 200 ms = every tick (physical minimum); ≥1000 ms = a view
  older than the window, i.e. blind.
- Static-quota mode and the ticket-sale scenario were stretch goals; both shipped.
- Deploy path: push `main` to GitHub, import the repo in the Vercel dashboard; pushes auto-deploy.
- Tests use vitest so they can import the engine straight from the `.tsx` file.

## Milestones

| # | Step | Status |
|---|------|--------|
| 1 | Scaffold: Vite + React 19 + TS, Tailwind v4, lucide-react, vitest, docs, git | done |
| 2 | Engine (pure, exported) + 9 invariant tests green | done |
| 3 | UI: stage, node/store cards, particles, controls, metrics strip, chart, narration | done |
| 4 | Polish: tour, CAP badge, heal report, static quota UI, ticket sale | done |
| 5 | Build, `vercel.json`, docs final, push to GitHub | done |
| 6 | Review round 1: intro overlay, ticket-sale drops, restart on mode/link change, spotlight tour with auto-play | done |
| 7 | Review round 2: seven presets with hints, gossip explainer tooltip, three-strategy comparison, share links | done |
| 8 | Vercel import, verify live URL (https://cap-rate-limit-sim-1.vercel.app/, headers and shared link checked) | done |

## What shipped

Stage with request dots, gossip pulses and CP round trips; belief-vs-truth bars on every node; store card
with ground truth and the store's own lagging count; cut/heal buttons on each wire and link switches;
traffic and gossip sliders; a flash-crowd spike; six-tile metrics strip with the Debt
ledger and plain-language tooltips; 30 s chart with overshoot fill, latency line and cut/heal/burst/drop
markers; one-line narration; first-visit intro overlay ("What is CAP?"); eight-step spotlight tour with
auto-play; CAP triangle badge; ticket-sale scenario run as repeated drops with a result log; static-quota
mode; seven scenario presets with "what to watch" hints; hover explainer for gossip delay; live
three-strategy comparison on identical traffic; shareable URL state with a copy-link button;
reduced-motion fallback.

Not built, by choice: mobile layout (desktop-first, collapses to one column under 1180 px), CP queueing or
store congestion, node-to-node partitions, the steady-state formula as a UI hint.

## Verification

- `npm test` green (9 engine invariants), `npm run build` clean.
- Browser (1440×960): sliders change behavior as designed, CP never exceeds 1000, cut/heal works in both
  modes with the expected narration and float-up, tour steps apply their settings, ticket sale oversells
  in AP and sells exactly 1000 in CP, static quota caps each node at 250, no console errors.
- Live URL matches local; security headers present.
