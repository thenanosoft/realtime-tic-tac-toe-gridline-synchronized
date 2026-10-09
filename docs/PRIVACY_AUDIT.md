# Privacy audit

**Date:** 2026-10-08 · **Scope:** Phase 12 (`P12-01` … `P12-08`) · **Status:** complete

Gridline claims that a room exists only while it is being played, and that nothing anyone says
survives it. This document is the evidence for that claim. Every statement below names either a
file you can read or a test you can run; where something *is* retained, it is listed here with
what it contains and why it is allowed.

The audit is not a snapshot. `tests/privacy.test.ts` encodes it as an inventory with an allowlist,
so a new place that could retain content fails the suite and has to be argued for here before it
can ship. `tests/logAudit.test.ts` runs a whole match with every output stream captured and
searches it for what was said.

---

## 1. What is retained, in full

Two things, both in the browser, neither containing anything a person wrote.

| Where | Key | Contents | Why it is allowed |
| --- | --- | --- | --- |
| `sessionStorage` | `gridline.session.v1` | room code, player token, player id, display name, mark | The handle that lets a refresh rejoin the same room as the same player. It is cleared when the session ends and dies with the tab. Asserted field-by-field in `tests/privacy.test.ts` → *"stores the session handle and nothing else"*. |
| `localStorage` | `gridline.muted` | `"true"` or `"false"` | One boolean: whether the player muted the sound. Asserted in *"keeps the mute preference as a boolean word"*. |

Nothing else is written anywhere. In particular:

- **No room key is ever stored** (`tests/privacy.test.ts` → *"never stores a room key"*). The room
  secret lives in the URL fragment and in memory. A second copy in storage would outlive the tab
  that earned it.
- **No IndexedDB, no cookies, no Cache API** outside the service worker, which caches the
  application shell and its static assets and nothing else (`public/sw.js`, `isAsset`).

## 2. The server writes nothing down

`server/` contains no filesystem path at all — no `node:fs`, no temp directory, no upload
directory. Asserted in `tests/privacy.test.ts` → *"has no filesystem write path at all"* and
*"has no upload directory, because uploads are never files"*.

This is a design consequence, not an omission. Phase 7 assembles chunked uploads **in memory** and
hands the result to the room. The conventional shape — write chunks to a temp directory, assemble,
unlink — is the one that leaves attachments on a disk after a crash.

There is no database client, no object storage client, and no analytics of any kind (same test
file, one rule per category). Rooms live in a `Map` and die with the process (D-003), which is why
a restart is a loss of all rooms and is documented as such rather than worked around with a store.

## 3. Logging

The server writes exactly two lines, both in `server/index.ts`: one when it starts listening, one
if it fails to start. Nothing in the room, protocol or socket paths logs anything at all.

`tests/logAudit.test.ts` is the real evidence. It plays a full match — sealed text, a sticker, a
quick reaction, a sealed image over the chunked transport, five moves, a malformed frame and a
refused command — with `console.log/info/warn/error/debug/trace` **and** the raw `process.stdout`
and `process.stderr` writes captured, then asserts that the output contains:

- none of the plaintext, and none of the ciphertext either — a log of unreadable bytes is still a
  log of the conversation, and it would outlive the room that held the key;
- no image data, no room secret, no player token;
- in fact **nothing at all**. "It did not log the secret" is a weaker claim than "it did not log",
  and the second is the one this product makes.

The malformed-frame case is deliberate: an error handler that serialises the frame it choked on is
exactly the leak a reading of the code would miss.

## 4. What the server can and cannot read

| Data | Server sees | Note |
| --- | --- | --- |
| Board, turn, result, series score | Yes | It is the authority on the match (INV-14). Encrypting it would mean no server-side rules at all. |
| Chat text, in a plain room | Yes, in RAM, for the life of the room | Ordered, rate-limited and budgeted by the server. |
| Chat text, in an encrypted room | **No** | AES-GCM, sealed in the browser. The server stores and forwards ciphertext and an IV (Phase 8, `tests/encryption.test.ts`). |
| Images, in an encrypted room | **No** | Sealed whole, then chunked. The server cannot even sniff the format, which is why that check moved to the receiving client. |
| The room key | **Never** | Generated in the browser, carried in the URL fragment, which is stripped before any request leaves the machine. `tests/encryption.test.ts` keeps a transcript of every frame the server received and searches it for the secret. |
| Who anybody is | Nothing to see | There are no accounts. Identity is a temporary name, and the avatar is derived from it (Phase 10) rather than stored. |

## 5. Lifetime

| Thing | Lives for | Enforced by |
| --- | --- | --- |
| A room with nobody attached | 90 seconds | `RoomManager.sweep` |
| A room waiting for its second player | 10 minutes | `RoomManager.sweep` |
| A player's reservation after disconnecting | 10 minutes beyond the reconnect deadline | `RoomManager.sweep` |
| Chat content, when the host enables expiry | 5 minutes, announced via `chat.expired` so clients revoke their blob URLs | `RoomManager.expireContent` (P7-08) |
| Everything, on a rotated key in an encrypted room | Until the rotation | `RoomManager.rotateRoomKey` (D-010) |
| Everything, on server restart | Not at all | D-003 |

## 6. Known limits, stated plainly

- **Game state is not encrypted.** The server has to read the board to be the authority on it.
  Encryption covers what the two players say to each other.
- **A plain room's chat is readable by the server** while the room exists. That is what the
  encryption option is for, and it is on by default for rooms opened from the lobby.
- **Everyone holding the invitation link holds the room key**, watchers included (D-015, which
  replaces the narrower D-011). The circle is "whoever has the link", not "the two people
  playing". The server still cannot read any of it - that part is unchanged and is the part the
  encryption is for.
- **An invitation link is a bearer token.** Anyone who has it can read the conversation, and since
  Phase 13 can also open it as a watcher. The share panel says so, in those words.
- **`navigator.onLine` is not a security boundary** and is not used as one; it only explains why a
  socket failed (P11-09).

## 7. How to re-run this audit

```
npm test                     # includes tests/privacy.test.ts and tests/logAudit.test.ts
npm run test:chaos           # invariants under adverse networks
GRIDLINE_CHAOS_MATRIX=1 npm run test:chaos   # the full matrix, as CI runs it
npm run test:e2e             # two browsers, including a network cut mid-match
```

A failure in `tests/privacy.test.ts` means something in this document has stopped being true.
