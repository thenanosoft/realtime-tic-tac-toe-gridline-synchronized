/**
 * Invitations (P8-01, P8-02, P8-07).
 *
 * Everything an invitee needs is in the URL *fragment*. That is the whole point
 * of the choice: a query string is sent to the server on every request for the
 * page, and a path is sent too, but a fragment is stripped by the browser
 * before the request leaves the machine. The room secret therefore travels
 * through the link itself and never through Gridline's infrastructure - not
 * past GitHub Pages, not past Render, not in the WebSocket handshake.
 *
 * `#r=CODE&k=SECRET`. The room code rides in the fragment too, even though it
 * is not secret, so that one copied string is the entire invitation and there
 * is no second form a user could paste into the wrong field.
 */
import { isRoomSecret } from './crypto';
import { ROOM_CODE_PATTERN } from '../../shared/protocol';

export interface Invite {
  roomCode: string;
  /** Null for a room that was created without encryption. */
  secret: string | null;
}

export function buildInviteUrl(base: string, invite: Invite): string {
  // Any fragment already on the base is replaced, not appended to: a stale
  // secret left in the address bar must not end up in a new invitation.
  const withoutFragment = base.split('#')[0];
  const fragment = invite.secret
    ? `r=${invite.roomCode}&k=${invite.secret}`
    : `r=${invite.roomCode}`;
  return `${withoutFragment}#${fragment}`;
}

/**
 * Reads an invitation out of a fragment, rejecting anything malformed.
 *
 * A fragment is attacker-supplied input like any other, so a code that is not a
 * room code and a key that is not the right shape are both discarded rather
 * than passed on to be puzzled over later.
 */
export function readInvite(hash: string): Invite | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const roomCode = (params.get('r') ?? '').trim().toUpperCase();
  if (!ROOM_CODE_PATTERN.test(roomCode)) return null;
  const key = params.get('k');
  if (key && !isRoomSecret(key)) return null;
  return { roomCode, secret: key || null };
}

export type ShareOutcome = 'shared' | 'copied' | 'manual';

export interface ShareTargets {
  share?: (data: { title: string; text: string; url: string }) => Promise<void>;
  copy?: (text: string) => Promise<void>;
}

/**
 * Share sheet first, clipboard second, and the URL on screen as the floor.
 *
 * `navigator.share` rejects when the user dismisses the sheet, which is not a
 * failure and must not be reported as one - but it is indistinguishable from a
 * real error, so both fall through to the clipboard. Copying an invite the user
 * decided not to send costs them nothing.
 *
 * The invite URL is passed through untouched. Share targets that re-encode a
 * URL have been known to drop the fragment, which is why the caller always
 * keeps the link visible as well.
 */
export async function shareInvite(url: string, targets: ShareTargets): Promise<ShareOutcome> {
  if (targets.share) {
    try {
      await targets.share({ title: 'Gridline', text: 'Play me a round of Gridline.', url });
      return 'shared';
    } catch {
      // Dismissed or unsupported: fall through rather than reporting a failure.
    }
  }
  if (targets.copy) {
    try {
      await targets.copy(url);
      return 'copied';
    } catch {
      // Clipboard access can be denied outright; the link stays on screen.
    }
  }
  return 'manual';
}
