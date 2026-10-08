'use client';

import { useMemo, useState } from 'react';
import { encodeQr, qrSvgPath } from '../lib/qr';
import type { ShareOutcome } from '../lib/invite';

interface InvitePanelProps {
  roomCode: string;
  /** Null until the room exists. Carries the key in its fragment when private. */
  inviteUrl: string | null;
  encrypted: boolean;
  onShare(): Promise<ShareOutcome>;
}

const OUTCOME_LABEL: Record<ShareOutcome, string> = {
  shared: 'Shared',
  copied: 'Copied',
  manual: 'Copy it below',
};

/**
 * One invitation, three ways to hand it over (P8-07, P8-08).
 *
 * The share sheet is the best route where it exists, the clipboard is the
 * fallback, and the link itself stays on screen as the floor - because the one
 * failure mode that matters here is a share target that re-encodes the URL and
 * drops its fragment. If that happens the player can still read the real link
 * and send it themselves.
 */
export function InvitePanel({ roomCode, inviteUrl, encrypted, onShare }: InvitePanelProps) {
  const [outcome, setOutcome] = useState<ShareOutcome | null>(null);
  const [showQr, setShowQr] = useState(false);

  // Encoded in the browser, never fetched. A hosted QR service works by being
  // sent the thing you want encoded, which for this URL means handing over the
  // room key (P8-08).
  const qr = useMemo(() => {
    if (!showQr || !inviteUrl) return null;
    try {
      return encodeQr(inviteUrl);
    } catch {
      return null;
    }
  }, [inviteUrl, showQr]);

  const share = async () => {
    const result = await onShare();
    setOutcome(result);
    if (result !== 'manual') setTimeout(() => setOutcome(null), 2_000);
  };

  return (
    <div className="invite-panel">
      <div className="invite-actions">
        <button
          className={`copy-room ${outcome && outcome !== 'manual' ? 'copied' : ''}`}
          onClick={() => void share()}
          disabled={!inviteUrl}
          aria-label={`Share the invitation link for room ${roomCode}`}
        >
          <span className="copy-icon" aria-hidden="true" />
          {outcome ? OUTCOME_LABEL[outcome] : 'Share invite'}
        </button>
        <button
          className={`qr-toggle ${showQr ? 'is-open' : ''}`}
          onClick={() => setShowQr((current) => !current)}
          disabled={!inviteUrl}
          aria-expanded={showQr}
          aria-label={showQr ? 'Hide the invitation QR code' : 'Show an invitation QR code'}
        >
          <span aria-hidden="true">▣</span>
          <span className="btn-label">QR</span>
        </button>
      </div>

      {showQr && (
        <div className="invite-qr">
          {qr ? (
            <svg
              // The quiet zone is part of the symbol, not decoration: without
              // four modules of margin a scanner cannot find the edges.
              viewBox={`-4 -4 ${qr.size + 8} ${qr.size + 8}`}
              role="img"
              aria-label={`QR code containing the invitation link for room ${roomCode}`}
            >
              <rect x={-4} y={-4} width={qr.size + 8} height={qr.size + 8} fill="#ffffff" />
              <path d={qrSvgPath(qr)} fill="#05070c" shapeRendering="crispEdges" />
            </svg>
          ) : (
            <p className="invite-qr-failed">This link is too long to show as a QR code.</p>
          )}
          <p className="invite-url">
            <code>{inviteUrl}</code>
          </p>
          {encrypted && (
            <p className="invite-warning">
              <span aria-hidden="true">⌁</span>
              This link holds the room key. Anyone who has it can read this conversation, and we cannot.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
