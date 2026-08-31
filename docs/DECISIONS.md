# Decision log

Numbered, dated, and never rewritten — superseded decisions get a new entry that references
the old one. Open decisions carry a recommendation and say who must decide.

---

## D-001 — Toolchain unavailable in the agent shell · **RESOLVED** · raised and closed 2026-08-29

**Problem.** `git`, `node` and `npm` were all absent from the shell PATH, which contained only
Windows system directories, `WindowsApps` and VS Code's `bin`. Nothing could be built, tested,
linted or committed. A search of `C:\` and the user profile found no Node installation, yet the
repository had a populated `node_modules/` and a valid `.git` on `main` — the project had been
built from a differently-configured environment.

**Resolution.** The toolchain lives on the `D:` drive under `D:\Android`, which was never on
PATH. Fixed as follows:

1. **Git installed properly.** `winget install --id Git.Git --scope user` → Git **2.55.0.3** at
   `C:\Program Files\Git\cmd`, added to the machine PATH by its own installer. Flutter's bundled
   MinGit at `D:\Android\flutter\bin\mingit\cmd\git.exe` was found first but is **git 2.15.1
   from 2017** — too old to rely on. Only `D:\Android\flutter\bin` was added to PATH, not the
   nested `mingit\cmd`, so that binary stays invisible to `git` lookups and cannot shadow the
   real one.
2. **User PATH extended** (persistent, `HKCU\Environment`, written as `REG_EXPAND_SZ`; the
   previous value is backed up in the session scratchpad as `user-path-backup.txt`):

   | Path | Provides |
   | --- | --- |
   | `D:\Android\nodejs` | node 22.20.0, npm 10.9.3, npx, corepack |
   | `%APPDATA%\npm` | npm global bin (directory created — it did not exist) |
   | `D:\Android\flutter\bin` | flutter, dart |
   | `D:\Android\sdk\platform-tools` | adb, fastboot |
   | `D:\Android\sdk\cmdline-tools\latest\bin` | sdkmanager, avdmanager |
   | `D:\Android\sdk\emulator` | emulator |

3. **`ANDROID_HOME` and `ANDROID_SDK_ROOT`** set to `D:\Android\sdk` (both were unset).
4. **`safe.directory` exception added** for `E:/Programming/AI_2026/tic-tac-toe`. The working
   tree is owned by SID `S-1-5-21-2083183181-…-1001`, from a previous Windows installation or
   account, while the current user is `S-1-5-21-3168555527-…-1000`. Git refused all operations
   until the exception was added. Commit identity was already configured locally as
   `Nanosoft <support@thenanosoft.com>` and was left untouched.

**Caveat for running sessions.** A process inherits its environment at launch, so any editor or
agent session started *before* this change still sees the old PATH and must prepend it manually:

```powershell
$env:PATH = "D:\Android\nodejs;C:\Program Files\Git\cmd;$env:PATH"
```

Restarting VS Code picks up the new PATH permanently.

**Node version note.** `package.json` requires `>=22.13.0`; the installed runtime is 22.20.0.
npm reports that 12.0.2 is available (10.9.3 installed) — not upgraded, because the lockfile and
CI were produced with npm 10 and changing it is not a Phase 0 concern.

---

## D-002 — Multi-tab ownership policy · **DECIDED** · raised 2026-08-29, decided 2026-08-31

**Problem.** When the same session token is opened in a second tab, three policies are
defensible: (A) newest connection takes control, (B) original connection keeps control,
(C) secondary connection becomes read-only.

**Current behaviour, for reference.** `RoomManager.resumeSession`
(`server/rooms/RoomManager.ts:183-186`) closes the previous socket with code 4001, and
`useGameSocket` renders a passive "This session was resumed in another window" notice. That is
policy A implemented implicitly, with the old tab losing its connection entirely rather than
being told it is now a viewer.

**Recommendation: A + C combined.** The newest connection takes control, and the displaced tab
is **kept connected in an explicit read-only state** rather than disconnected. Reasons:

- A alone matches user intent — someone opening the game on a new device wants to play there.
- Closing the old socket makes the old tab look broken. Keeping it alive and labelled
  ("Another window has control of this session") is honest and recoverable — the user can
  click "Take control here" to reverse it.
- It exercises exactly what the brief is testing: identity, presence, and socket ownership as
  distinct concepts, rather than a single boolean.
- B is worse in practice: a phone that lost signal cannot get its own session back.

**Consequence if accepted.** The presence state machine (`P4-01`) gains a `read-only` viewer
attachment distinct from a player slot, and the capability model (`P6-01`) has to distinguish
"holds the player slot" from "is connected as this player".

**Decision (2026-08-31).** The recommendation is accepted: **newest connection takes control,
displaced connection becomes explicitly read-only** rather than being disconnected.

**What this obliges Phase 4 to build.**

1. A player slot and a *connection* become separate things. Several connections may be attached
   to one player; exactly one of them holds the slot.
2. `resumeSession` stops closing the previous socket with code 4001. It demotes it instead, and
   tells it why.
3. The demoted view says so in words — not a disabled board with no explanation — and offers
   **Take control here**, which is the same claim operation in the other direction.
4. The presence state machine (`P4-01`) gains a read-only attachment distinct from the slot, and
   the capability model (`P6-01`) has to distinguish *holds the player slot* from *is connected
   as this player*.
5. INV-6 tightens rather than loosens: several connections per player are now legal, but exactly
   one may be able to act. The chaos suite already measures that, and `P4-09` extends it to
   reconnect storms with two attached connections.

**Note on the reversal button.** "Take control here" makes the policy symmetric, so two tabs can
in principle fight over the slot. That is acceptable because each claim is a server-authoritative
command with a revision — the loser of the race is told it lost, exactly as a rejected move is.
It must not be implemented as a client-side toggle.

---

## D-003 — Server restart destroys all rooms · **DECIDED** · 2026-08-29

**Decision.** Rooms are ephemeral and do **not** survive a server restart. No persistence layer
will be added to work around this.

**Rationale.** It is the stated philosophy of the product, and it is what makes the privacy
claims provable. Adding persistence to survive restarts would undermine INV-8 for a marginal
availability gain on a free-tier host that restarts frequently anyway.

**Consequence.** `P4-08` becomes mandatory: clients must reach a clear, explained terminal
state after a restart and offer a path to a new room. A client that hangs, retries forever, or
shows a stale board is a bug, not an acceptable degradation.

---

## D-004 — Server ships before client for protocol changes · **DECIDED** · 2026-08-29

**Decision.** Any change to the wire protocol deploys to Render first, then to GitHub Pages.

**Rationale.** The two deploy independently and neither can be atomically coordinated with the
other. A new server must therefore accept old clients for one release cycle. The reverse — a
new client against an old server — is the failure mode we cannot avoid entirely, which is why
`P2-01` (protocol versioning) exists: it converts a confusing silent failure into a clear
"please refresh" message.

---

## D-005 — Optimistic UI is introduced, reversing the current design · **DECIDED** · 2026-08-29

**Decision.** Phase 5 adds speculative local move rendering, replacing the current strictly
pessimistic model.

**Rationale.** `README.md` currently documents "the browser never applies a move optimistically"
as a deliberate safety property, and it is a reasonable one. But the brief explicitly requires
instant responsiveness with graceful rollback, and the pessimistic model costs a full round
trip — on a Singapore free-tier host that is very visible.

**Consequence.** INV-1 and INV-2 become the hardest invariants in the system. Phase 5 must not
start before Phase 3's chaos suite can assert them continuously. `README.md` must be corrected
in the same change, since it will otherwise document the opposite of the truth.

---

## D-006 — Room memory budget refuses rather than evicts · **DECIDED** · 2026-08-29

**Decision.** When a room hits its attachment memory budget, the new upload is **rejected** with
a specific code. It does not silently evict the oldest attachment.

**Rationale.** Current behaviour (`RoomManager.pruneChat`, line 504) drops the oldest image to
stay under `ROOM_IMAGE_MEMORY_LIMIT`. That means a user's shared image can vanish from the
conversation with no explanation, which reads as data loss. An explicit refusal is honest and
lets the sender retry with a smaller image.

**Consequence.** `P7-04`. The budget rises from 6MB to the specified 10MB per room, and a
process-wide 50MB ceiling is added, which does not exist today.

---

## D-007 — E2EE is deferred to Phase 8, not retrofitted earlier · **DECIDED** · 2026-08-29

**Decision.** Encryption lands after the media pipeline (Phase 7) and the capability model
(Phase 6), not before.

**Rationale.** Encrypting a transport that is about to be replaced by chunked transfer would be
wasted work, and key distribution has to account for spectators — who must never hold room keys.
Designing E2EE before the capability model exists would mean designing it twice.

**Consequence.** `README.md`'s current statement that E2EE is not implemented stays accurate
until Phase 8, and must be updated the moment it lands.

---

## D-008 — The two deploys cannot be sequenced, so the client must degrade honestly · **DECIDED** · 2026-08-31

**Problem, observed rather than theorised.** D-004 says the server ships before the client for
any protocol change. Phase 2 was exactly such a change. But a single push to `main` triggers the
GitHub Pages workflow *and* Render's auto-deploy at the same moment, and nothing sequences them.
Immediately after pushing `c02aa53`, a probe of `wss://gridline-realtime.onrender.com/ws`
returned a `server.hello` with **no `protocolVersion` at all** — the v1 server — while the Pages
build was already running.

So D-004's ordering is an intention the deployment topology cannot actually enforce.

**Decision.** Do not try to sequence the two deploys. Rely on the client degrading honestly
instead, which is what `P2-01` and `app/lib/protocolCompatibility.ts` were built for.

**Why not sequence them.** The alternatives are all worse for a project of this size:

- Gating the Pages workflow on a Render health probe couples two providers and turns any Render
  hiccup into a frontend outage.
- Deploying the server from a separate branch adds a release ritual that will be forgotten
  exactly once, on the change where it matters.
- Manually pausing auto-deploy means remembering to unpause.

**What the window actually costs.** During it, a v2 client reaching a v1 server sends
`expectedRevision` where the old schema expects `expectedVersion`, so moves are rejected as
`MALFORMED_MESSAGE`. The client detects the mismatch from the missing `protocolVersion` in
`server.hello` and shows *"The realtime service is running an older version…"* rather than
failing silently. The room is unplayable for the length of the window; it is not corrupted, and
it recovers on its own once Render finishes.

**Consequence.** The honest-degradation path is now load-bearing infrastructure, not a nicety.
Two obligations follow:

1. Never remove or weaken the `legacy-server` branch of `evaluateServerHello`, and keep its test
   in `tests/compatibility.test.ts`.
2. When a protocol change ships, verify the backend has caught up before announcing it. The
   probe used here reads `server.hello.protocolVersion` directly, which is the only reliable
   signal — `/health` does not report a version. Adding one is worth doing (tracked as a note
   against Phase 12's audit work).
