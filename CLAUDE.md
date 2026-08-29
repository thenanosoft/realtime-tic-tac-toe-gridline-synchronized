@AGENTS.md

## Engineering record

The hardening programme is planned and tracked in [`docs/`](./docs/README.md). Before
starting work, read:

- [`docs/TODO.md`](./docs/TODO.md) — what is done and what is next. Task IDs are stable;
  reference them in commits (`P1-01: give the board explicit grid rows`).
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) — the 13 phases and their exit criteria.
- [`docs/INVARIANTS.md`](./docs/INVARIANTS.md) — correctness properties that must never break.
- [`docs/DECISIONS.md`](./docs/DECISIONS.md) — settled and open architectural decisions.

Working rules: one phase at a time, a task is done only when it is tested, and docs move in
the same change as the code.
