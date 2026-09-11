# Design — CAP in Practice: Distributed Rate Limiting

Living design doc. The engine at the top of `src/CapSimulator.tsx` implements exactly this; when they
disagree, fix one and note it in the decision log.

## 1. What the simulation shows

Four CDN edge nodes admit or reject incoming requests under one shared rule: at most 1000 requests per
second, globally, over a sliding 1 s window. A central store in Virginia holds the counters. Each node can
decide in one of three ways:

| Mode | Decision | Consistency | Availability under partition | Latency |
|------|----------|-------------|------------------------------|---------|
| Eventual (AP) | local counter + last gossiped view of the others | approximate, overshoots | keeps serving on a stale view | ~1 ms |
| Strong (CP) | atomic check-and-increment at the store | exact | fails closed, users get errors | RTT to Virginia (15–160 ms) |
| Static quota | local counter against a fixed 250/s share | exact | keeps serving | ~1 ms, wastes capacity under skew |

The stage always shows the ground truth at the store and each node's belief on its card. The gap between
them is the whole lesson. A second scenario, the ticket sale, uses the same engine with a counter that
never refills (1000 seats): AP oversells, CP sells exactly 1000, a cut-off CP region sells nothing.

First-time visitors get an intro overlay (the problem, the theorem in plain words, how to read the screen)
and an eight-step guided tour that applies settings and spotlights the control each step is about.

## 2. Time and counters

- Tick = 200 ms. Window `W` = 5 ticks (1 s). Limit `L` = 1000.
- Each node keeps a ring of admits per tick (`ring[t % W]`) and a running `total`.
- `ownExcl(t)` = the node's admits in ticks `t−W+1 … t−1` (the slot for `t` still holds `t−W` until written).
- Ground truth `truthWindow(t)` = Σ over nodes of the last `W` ticks after this tick's admits are written.
- Ticket sale = `W = ∞`: `total` replaces the ring; the limit is 1000 seats.

## 3. Traffic generator

- Deterministic PRNG (mulberry32) with two streams: traffic and latency. Arrivals are identical across
  modes for the same seed, so mode comparisons are honest. Seed 1 in the UI; Reset replays the same data.
- Per node per tick: `λ = ratePerNode · w_i(t) · m_i(t) · 0.2`, arrivals ~ Poisson(λ)
  (Knuth for λ < 30, normal approximation above).
- Skew: `w_i(t) = 1 + skew · sin(2π t / P_i + i·π/2)`, `P = [185, 265, 355, 485]` ticks, normalized to mean 1,
  so one region is always hotter and the hot spot wanders. Default skew 0.2.
- Flash crowds: a trapezoid multiplier (25 % ramp up, hold ×3, 25 % ramp down) on one node for 4 s, scheduled
  by the Flash crowd preset every 12 s or triggered by the Spike button.

## 4. Admission per tick

Order: arrivals → ideal limiter → admission → write rings → gossip sync → latency → metrics → partition
bookkeeping. Sync runs after admission so a pushed report includes this tick's admits.

- **AP**: `budget = max(0, L − ownExcl − belief)`; admit `min(incoming, budget)`; the rest are rejected.
  Partitioned nodes decide the same way; their belief just ages.
- **Static**: `budget = max(0, L/N − ownExcl)`.
- **CP**: partitioned nodes fail every request (counted as `failed`, not `rejected`). The others share
  `R = max(0, L − Σ ownExcl)` proportionally to their incoming traffic (largest-remainder rounding), the
  per-tick equivalent of atomic increments interleaving at the store. Truth never exceeds `L`.
- **Ideal limiter**: an omniscient limiter run on the same arrivals. Ledgers compare cumulative admits
  against it since the last mode switch: `Debt = max(0, admitted − ideal)` (admitted beyond the limit) and
  `under = max(0, ideal − admitted)` (turned away needlessly). Net accounting is the honest measure: a
  per-tick `max(0, window − L)` sum would count the same overshoot five times.

## 5. Gossip (AP only)

- `k = max(1, round(gossipMs / 200))`. Node `i` syncs when `(t − floor(i·k/N)) mod k = 0`, so pulses are
  staggered. All pushes happen before all pulls. A node also syncs immediately when its link heals and
  everyone syncs when the mode switches to AP.
- Push: the node's last `W` per-tick buckets, timestamped, to the store. Pull: the store's latest report for
  every other node.
- **Belief** is recomputed every tick from the pulled buckets, counting only buckets still inside the current
  window. It decays toward zero as the view ages without any new sync. This is what a real sliding-window
  limiter does when it stops hearing from its peers, and it is why overshoot grows smoothly with the gossip
  interval instead of oscillating.
- View age = ticks since the node last pulled anything. A view older than `W` is blind: the node counts
  only itself. Two-hop staleness emerges naturally: a report is already up to one interval old when pulled.
- The store's own number (`store knows`) is the same window sum over the reports it holds; in AP it lags
  the truth too.

## 6. Measured steady state (seed 11, skew 0, 500 req/s per node = 2× the limit)

| Gossip | Admitted (truth) | Formula estimate |
|--------|------------------|------------------|
| 200 ms (every tick) | ≈ 1200 | 1176 |
| 400 ms | ≈ 1220 | 1429 |
| 600 ms | ≈ 1500 | 1818 |
| 800 ms | ≈ 1750 | 2000 |
| 1000 ms (= window) | ≈ 1900 | 2000 |
| ≥ 1400 ms | 2000, limiter off | 2000 |

Formula: `miss(k) = mean_{x=1..2k−1} min(W, x)`, `s = miss(k)/W`, `predicted = min(offered, N·L / (1 + (N−1)(1−s)))`
(`predictedTotalRps` in the engine). It overestimates at 2–3 ticks because staggered syncs help; it is a
sanity bound, not a display value. Even at "every tick" there is a floor of ~20 % above the limit: four
nodes fill the same free budget at the same moment. CP is the only true zero.

Other calibration points: CP at 400/node holds exactly 1000 at ~98 ms mean decision latency. Static quota
at 300/node with skew 0.3 admits ~986 and turns away ~1000 requests per minute needlessly. Partition storm
(500/node, Tokyo cut): AP admits ~1760, CP admits 1000 at ~73 % availability.

## 7. Partition

Cutting a node's link stops its pushes and pulls. In AP it keeps serving; its view ages and the debt
accrued during the cut is attributed to it. In CP it fails closed. On heal the engine emits a report
(duration, excess admitted, requests failed); the narration turns it into the sentence that makes CAP
concrete and the stage floats the number up from the node.

## 7a. Ticket drops

The ticket sale runs as repeated drops so every setting can be compared on a fresh 1000-seat inventory:

- Buyers arrive at a tenth of the rate-limit slider (`TICKET_RATE_SCALE`), so 300 on the slider is
  30 buyers/s per site, 120/s in total, and a drop takes about eight seconds instead of one.
- A drop closes when the venue is full (`total ≥ L`) and no site has sold for three ticks. That lets AP
  finish overselling before the result is recorded: sites keep selling until they hear the news.
- The result (mode, gossip, cut links, seats sold, errors, mean decision latency) goes into a log shown at
  the bottom of the stage. After a 5 s hold (`DROP_HOLD_TICKS`) the counters clear and the next drop starts.
- Switching mode, cutting or healing a link, or pressing "New drop" restarts the drop immediately, so the
  outcome always reflects the current choice. Slider changes wait for the next drop.
- A cut-off AP site never hears that the venue is full; it sells until its own count plus the last total
  it heard reaches 1000, which can take most of a minute at 30 buyers/s. The narration says so.

## 8. Metrics

| Metric | Definition |
|--------|------------|
| Incoming | Σ arrivals over the last window (per second) |
| Admitted (truth) | `truthWindow` |
| Overshoot | `max(0, truthWindow − L)` |
| Debt | cumulative admitted − ideal since the last mode switch; sub-line: cumulative under-admission |
| Availability | `1 − Σ failed / Σ incoming` over the last window |
| Decision latency | answered-weighted mean: AP/static `1 + u` ms, CP `max(rtt/2, rtt·(1 + 0.15 z) + 2)` ms |

## 9. Visual encoding

| Color | Meaning |
|-------|---------|
| emerald | admitted |
| rose | rejected, cut link, overshoot, debt |
| sky | gossip pulse, a node's belief (AP accent) |
| amber | CP round trip, latency (CP accent) |
| violet | static quota accent |
| zinc | failed (no answer), neutral chrome |

Pulse color equals mode color. Between gossips the wires are silent in AP; in CP every request lights
them. One request dot stands for `⌈incoming per tick / 40⌉` requests (at most 8 admitted, 5 rejected and
5 failed dots per node per tick); dots enter from the stage edge, green ones pass into the card, red and
grey ones bounce off it. Each node card shows its belief as a sky bar, the truth as a white tick and the
gap between them in rose.

## 10. Decision log

- 2026-09-11 — Gossip per-tick buckets instead of window sums. Frozen sum beliefs reach an exact steady state
  at any delay (`a = L − 3a`) and only oscillate on load changes; buckets make overshoot smooth and monotone.
- 2026-09-11 — Gossip slider floor is 200 ms because the tick is 200 ms; cap is 2000 ms because beyond the
  1 s window the node is blind and the curve plateaus. The plateau is a teaching point, not a bug.
- 2026-09-11 — Ledgers compare cumulative admits against an ideal limiter rather than summing per-tick
  window excess (which double counts). They restart on every mode switch so CP never shows AP's bill and
  refusing requests in CP cannot "pay down" debt.
- 2026-09-11 — View age is time since the node's last pull, not the age of its oldest report; otherwise a
  peer's partition made every healthy node read "blind".
- 2026-09-11 — CP admission uses a proportional share per tick (largest remainder) rather than per-request
  interleaving; identical totals, deterministic, fast.
- 2026-09-11 — Two PRNG streams so arrivals do not change when the mode changes.
- 2026-09-11 — The steady-state formula stays in the engine and this doc; it is not shown in the UI because
  at 400–600 ms it overestimates by ~15 %.
- 2026-09-11 — Ticket sale reworked into drops after review: a single sale at 1,200 buyers/s sold out in a
  second and changing mode afterwards changed nothing. Buyers now arrive at a tenth of the slider, a drop
  closes when selling stops, results are logged, and mode or link changes restart the drop.
- 2026-09-11 — Added the intro overlay and the spotlight tour after review: the acronym meant nothing to a
  first-time visitor and the text-only stepper did not show where to look.

## 11. Known simplifications

Per-tick bulk admission (no intra-tick ordering); no store congestion or queueing in CP; no clock skew;
latency is one draw per node per tick; partitions are node-to-store only (no node-to-node links); the
static quota is an even split, not a rebalancing scheme.
