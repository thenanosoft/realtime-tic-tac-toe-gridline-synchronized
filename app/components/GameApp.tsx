'use client';

import { ConnectionBadge } from './ConnectionBadge';
import { Lobby } from './Lobby';
import { GameRoom } from './GameRoom';
import { useGameSocket } from '../hooks/useGameSocket';
import { useGameSound } from '../hooks/useGameSound';

export function GameApp() {
  const game = useGameSocket();
  const sound = useGameSound();

  return (
    <main className="app-shell">
      <div className="grain" aria-hidden="true" />
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <header className="topbar">
        <div className="brand" aria-label="Gridline">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>
          <span>GRIDLINE</span>
        </div>
        <span className="eyebrow">A SHARED THINKING SPACE</span>
        <div className="header-actions">
          <button className="sound-toggle" onClick={sound.toggleMuted} aria-pressed={sound.muted} aria-label={sound.muted ? 'Unmute game sounds' : 'Mute game sounds'}>
            <span className="sound-glyph" aria-hidden="true">{sound.muted ? '×' : '•'}</span>
            <span className="btn-label">{sound.muted ? 'Muted' : 'Sound on'}</span>
          </button>
          <ConnectionBadge state={game.connection} />
        </div>
      </header>

      {!game.session && (
        <Lobby connection={game.connection} busy={game.lobbyBusy} onCreate={game.createRoom} onJoin={game.joinRoom} />
      )}
      {game.session && game.snapshot && (
        <GameRoom
          snapshot={game.snapshot}
          timing={game.timing}
          session={game.session}
          connection={game.connection}
          pendingMove={game.pendingMove}
          resyncing={game.resyncing}
          onMove={game.move}
          onRematch={game.voteRematch}
          playSound={sound.play}
          chatMessages={game.chatMessages}
          typingPlayerId={game.typingPlayerId}
          quickReactions={game.quickReactions}
          imagePreparing={game.imagePreparing}
          onSendText={game.sendChatMessage}
          onTyping={game.setTyping}
          onSticker={game.sendSticker}
          onQuickReaction={game.sendQuickReaction}
          onMessageReaction={game.toggleMessageReaction}
          onImage={game.sendImage}
          onLeave={game.leaveRoom}
        />
      )}
      {game.session && !game.snapshot && (
        <section className="restoring" role="status">
          <span className="waiting-rings" aria-hidden="true"><i /><i /><i /></span>
          <p>Restoring room <b>{game.session.roomCode}</b></p>
          <small>Requesting the latest board from the server…</small>
        </section>
      )}

      {game.notice && (
        <div className={`notice-toast notice-${game.notice.tone}`} role={game.notice.tone === 'error' ? 'alert' : 'status'}>
          <span aria-hidden="true">{game.notice.tone === 'error' ? '!' : 'i'}</span>
          <p>{game.notice.text}</p>
          <button onClick={game.dismissNotice} aria-label="Dismiss message">×</button>
        </div>
      )}
    </main>
  );
}
