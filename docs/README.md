# Gridline — Engineering Record

This folder is the durable record for the Gridline hardening programme. Nothing about
the plan lives only in a chat transcript.

| Document | Purpose |
| --- | --- |
| [ROADMAP.md](./ROADMAP.md) | The 13 phases: goal, scope, exit criteria, dependencies, risks. |
| [TODO.md](./TODO.md) | Every task as a checkbox with a stable ID (`P4-03`). The single source of truth for "what is done". |
| [UX_AUDIT.md](./UX_AUDIT.md) | Concrete UI/UX defects found in the current build, with file/line and root cause. |
| [DECISIONS.md](./DECISIONS.md) | Architecture decision log, including the decisions still open and who must make them. |
| [PROGRESS.md](./PROGRESS.md) | Running changelog. One entry per phase completed, written when the phase closes. |
| [INVARIANTS.md](./INVARIANTS.md) | The correctness properties the system must never violate. Tests exist to defend these. |

## How we work

1. **One phase at a time.** A phase is not started until the previous one's exit
   criteria are all green.
2. **Every task has an ID.** Commits reference it: `P2-04: add server sequence to chat`.
3. **A task is done when it is tested.** "It works when I click it" is not done.
   Each phase lists the tests that must exist before it closes.
4. **Docs are updated in the same change as the code.** If Phase 6 adds spectators,
   `README.md`, `TODO.md` and `PROGRESS.md` move in the same commit.
5. **No claim without proof.** Especially for the privacy and memory phases — the
   statement "data is ephemeral" must be backed by an automated test, not prose.

## Verification gates

Every phase must leave these green:

```bash
npm test              # vitest unit + integration
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run build         # vinext build
npm run build:pages   # next static export for GitHub Pages
```

From Phase 3 onward, two more gates apply:

```bash
npm run test:e2e      # Playwright, two browser contexts
npm run test:chaos    # adverse-network convergence suite
```

## Local environment

The toolchain lives on `D:\Android` and is on the persistent user PATH — see
[DECISIONS.md](./DECISIONS.md) D-001 for what was configured and why.

| Tool | Version | Location |
| --- | --- | --- |
| node | 22.20.0 | `D:\Android\nodejs` |
| npm | 10.9.3 | `D:\Android\nodejs` |
| git | 2.55.0.3 | `C:\Program Files\Git\cmd` |

A shell started *before* that PATH change must prepend it manually:

```powershell
$env:PATH = "D:\Android\nodejs;C:\Program Files\Git\cmd;$env:PATH"
```

## Branch and release strategy

- **`main` is the deploy branch.** A push to `main` deploys the frontend to GitHub Pages via
  `.github/workflows/pages.yml` and the backend to Render via the `render.yaml` blueprint.
  Both trigger independently and neither waits for the other.
- **One branch per phase**, named `phase/<n>-<slug>` — e.g. `phase/1-ui-foundation`. Merged to
  `main` only when every exit criterion for that phase is green.
- **Commits reference task IDs.** `P1-01: give the board explicit grid rows`.
- **Protocol changes ship server-first.** Because Pages and Render deploy independently, a
  breaking wire change must land on Render — accepting both old and new clients — before the
  matching frontend goes out. This is D-004, and `P2-01` (protocol versioning) exists to make
  the mismatch window fail loudly instead of silently.
- **Never push a phase branch that leaves a gate red.** The five verification gates are the
  merge condition, not a suggestion.

## Deployment topology (current, live)

- **Frontend** — GitHub Pages static export, `out/`, base path applied.
  `https://thenanosoft.github.io/realtime-tic-tac-toe-gridline-synchronized/`
- **Backend** — Render free Node web service (Singapore), `render.yaml` blueprint,
  `/health` health check, `/ws` WebSocket upgrade, auto-deploy from `main`.
- **Wiring** — GitHub Actions variable `NEXT_PUBLIC_WS_URL` = `wss://gridline-realtime.onrender.com/ws`.

Both sides are deployed and verified working. Any phase that changes the wire protocol
must ship the server first, because Pages and Render deploy independently — see
`P2-01` (protocol versioning) which exists specifically to make that safe.
