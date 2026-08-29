# Progress log

Newest first. One entry per phase closed, plus notable mid-phase events. Written when work
actually lands, never in advance.

---

## 2026-08-29 — Programme opened

**State inherited.** Gridline is deployed and working end to end:

- Frontend on GitHub Pages, static export, base path applied.
- Backend on Render (free tier, Singapore), `render.yaml` blueprint, `/health` + `/ws`.
- `NEXT_PUBLIC_WS_URL` configured as an Actions variable; Pages workflow run #5 green.
- Duplicate Pages workflow removed in `3f7d905`.
- Verified in production: two players joined, moves synchronised, no console warnings or
  errors. The earlier "production realtime endpoint not configured" warning is resolved.

**Codebase at start.**

| Area | Files | Notes |
| --- | --- | --- |
| Shared | `shared/protocol.ts`, `shared/game.ts` | Zod discriminated client union, pure game engine |
| Server | `server/rooms/RoomManager.ts` (29.7KB), `createGameServer.ts`, `identity.ts` | All room state in process RAM |
| Client | `app/hooks/useGameSocket.ts` (17.7KB), 8 components | Pessimistic moves, Blob URL lifecycle management |
| Styles | `app/globals.css` (58.2KB) | Hand-tuned, no type scale |
| Tests | `tests/multiplayer.test.ts` (22.4KB), `game.test.ts`, `identity.test.ts` | Unit + integration, no E2E, no chaos |

**Work done this session.**

- `P0-04` Created the `docs/` engineering record: README, ROADMAP (13 phases),
  TODO (~110 tasks with stable IDs), UX_AUDIT, INVARIANTS (12 properties), DECISIONS, this log.
- Audited the reported UI defects and found the root causes rather than the symptoms:
  - The shifting board is a missing `grid-template-rows` on `.game-board`, combined with
    gridlines painted as a fixed background gradient. Full analysis in `UX_AUDIT.md` S1-A.
  - Small type is systemic — 69 declarations under 12px, mobile bottoming out at 5px. There is
    no type scale in the codebase, so there was never a floor to violate.
  - Found seven further defects not originally reported, including clipped diagonal winning
    lines, no landscape layout at any breakpoint, sub-44px tap targets, a reduced-motion
    blanket kill switch, and a 9px chat input that triggers iOS zoom-on-focus.

**Toolchain resolved** (`P0-01`). Git 2.55.0.3 installed via winget; the Node/Flutter/Android
toolchain under `D:\Android` added to the persistent user PATH; `safe.directory` exception added
because the working tree is owned by a SID from a previous Windows installation. Full record in
`DECISIONS.md` D-001.

**Baseline gates** (`P0-02`) — all five green, no pre-existing failures:

| Gate | Result |
| --- | --- |
| `npm test` | 24 tests, 3 files, all pass — 5.80s |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` (vinext) | pass — 1 static route |
| `npm run build:pages` (next export) | pass — `/` and `/_not-found`, both static |

**Baseline metrics** (`P0-03`) — the numbers later phases are measured against:

| Metric | Value |
| --- | --- |
| `out/` total | 2,709 KB across 39 files |
| — JavaScript | 1,386 KB across 11 chunks |
| — CSS | 53 KB, 1 file |
| — HTML | 42 KB, 4 files |
| Largest chunk | 521 KB (`425eqet9207t4.js`) |
| Largest asset overall | 619 KB (`og.png`) |
| Sticker sheet | 431 KB (`gridline-stickers.webp`) |
| Server idle RSS | 37.1 MB working set / 49.4 MB private bytes |
| `/health` at idle | `{"status":"ok","rooms":0}` |

Two observations worth carrying into later phases: the 521 KB primary chunk and the 431 KB
sticker sheet together dominate first load, and neither has been examined for necessity yet.
Server RSS *with an active room holding an image* is still uncaptured — it belongs with the
Phase 7 memory-budget work, where it is the number that actually matters.

**Open decisions awaiting the user.**

- D-002 — multi-tab ownership policy. Recommendation recorded; needed before Phase 4.
