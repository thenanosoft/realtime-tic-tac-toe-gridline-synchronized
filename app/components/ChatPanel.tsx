'use client';

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  MAX_CHAT_TEXT_LENGTH,
  MESSAGE_REACTIONS,
  QUICK_REACTIONS,
  STICKER_IDS,
  type MessageReaction,
  type PlayerSnapshot,
  type QuickReaction,
  type StickerId,
} from '../../shared/protocol';
import type { ClientChatMessage } from '../hooks/useGameSocket';

const EMOJIS = ['😂', '🔥', '👏', '😮', '❤️', '🎯', '🤝', '✨', '😊', '😅', '🤔', '🙌', '👀', '💡', '⚡', '🏆', '🎉', '💯'];
const ASSET_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

interface ChatPanelProps {
  open: boolean;
  unread: number;
  messages: ClientChatMessage[];
  players: PlayerSnapshot[];
  selfId: string;
  connected: boolean;
  typingPlayerId: string | null;
  imagePreparing: boolean;
  onClose(): void;
  onSendText(text: string): boolean;
  onTyping(typing: boolean): void;
  onSticker(stickerId: StickerId): boolean;
  onQuickReaction(reaction: QuickReaction): boolean;
  onMessageReaction(messageId: string, reaction: MessageReaction): boolean;
  onImage(file: File): Promise<boolean>;
}

export function ChatPanel({
  open,
  unread,
  messages,
  players,
  selfId,
  connected,
  typingPlayerId,
  imagePreparing,
  onClose,
  onSendText,
  onTyping,
  onSticker,
  onQuickReaction,
  onMessageReaction,
  onImage,
}: ChatPanelProps) {
  const [text, setText] = useState('');
  const [picker, setPicker] = useState<'emoji' | 'sticker' | null>(null);
  const [preview, setPreview] = useState<ClientChatMessage & { kind: 'image' } | null>(null);
  const [newMessages, setNewMessages] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const typingRef = useRef(false);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousLastIdRef = useRef<string | null>(null);

  const typingPlayer = players.find((player) => player.id === typingPlayerId);
  const canChat = connected && players.length === 2;
  const activePreview = preview && messages.some((message) => message.id === preview.id) ? preview : null;

  useEffect(() => {
    if (!picker) return;
    const handlePointer = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setPicker(null);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPicker(null);
        textareaRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [picker]);

  useEffect(() => {
    if (!activePreview) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreview(null);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [activePreview]);

  useEffect(() => {
    const last = messages.at(-1);
    const isNew = Boolean(last && last.id !== previousLastIdRef.current);
    previousLastIdRef.current = last?.id ?? null;
    if (!open || !isNew) return;
    const viewport = scrollRef.current;
    if (!viewport) return;
    if (nearBottomRef.current || last?.senderId === selfId) {
      requestAnimationFrame(() => viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' }));
      setNewMessages(false);
    } else {
      setNewMessages(true);
    }
  }, [messages, open, selfId]);

  useEffect(() => {
    if (!open) return;
    const viewport = scrollRef.current;
    requestAnimationFrame(() => {
      viewport?.scrollTo({ top: viewport.scrollHeight });
      nearBottomRef.current = true;
      setNewMessages(false);
    });
  }, [open]);

  useEffect(() => () => {
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    if (typingRef.current) onTyping(false);
  }, [onTyping]);

  const stopTyping = () => {
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = null;
    if (typingRef.current) {
      typingRef.current = false;
      onTyping(false);
    }
  };

  const handleTextChange = (value: string) => {
    setText(value.slice(0, MAX_CHAT_TEXT_LENGTH));
    if (!value.trim()) {
      stopTyping();
      return;
    }
    if (!typingRef.current) {
      typingRef.current = true;
      onTyping(true);
    }
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(stopTyping, 1_300);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || !canChat) return;
    if (onSendText(text)) {
      setText('');
      stopTyping();
      setPicker(null);
    }
  };

  const insertEmoji = (emoji: string) => {
    const input = textareaRef.current;
    const start = input?.selectionStart ?? text.length;
    const end = input?.selectionEnd ?? start;
    const next = `${text.slice(0, start)}${emoji}${text.slice(end)}`.slice(0, MAX_CHAT_TEXT_LENGTH);
    handleTextChange(next);
    requestAnimationFrame(() => {
      input?.focus();
      const cursor = Math.min(next.length, start + emoji.length);
      input?.setSelectionRange(cursor, cursor);
    });
  };

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await onImage(file);
  };

  const scrollToLatest = () => {
    const viewport = scrollRef.current;
    viewport?.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
    nearBottomRef.current = true;
    setNewMessages(false);
  };

  return (
    <>
      <button className={`chat-scrim ${open ? 'is-visible' : ''}`} onClick={onClose} aria-label="Close private chat" tabIndex={open ? 0 : -1} />
      <aside ref={panelRef} className={`chat-panel ${open ? 'is-open' : ''}`} aria-label="Private room chat" aria-hidden={!open} inert={open ? undefined : true}>
        <header className="chat-header">
          <div>
            <span><i /> PRIVATE SESSION</span>
            <h2>Room chat {unread > 0 && <b aria-label={`${unread} unread messages`}>· {unread}</b>}</h2>
          </div>
          <button onClick={onClose} aria-label="Close private chat">×</button>
        </header>
        <p className="chat-privacy"><span aria-hidden="true">⌁</span> Messages and images disappear when this session ends.</p>

        <div
          className="chat-messages"
          ref={scrollRef}
          onScroll={(event) => {
            const target = event.currentTarget;
            nearBottomRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 70;
            if (nearBottomRef.current) setNewMessages(false);
          }}
        >
          {messages.length === 0 && (
            <div className="chat-empty">
              <span aria-hidden="true">⌁</span>
              <strong>Private room chat</strong>
              <p>{players.length < 2 ? 'Chat opens when your opponent arrives.' : 'Send a thought, reaction, sticker, or image.'}</p>
            </div>
          )}
          {messages.map((message) => {
            const mine = message.senderId === selfId;
            const sender = players.find((player) => player.id === message.senderId)?.name ?? 'Player';
            return (
              <article className={`chat-message ${mine ? 'is-mine' : 'is-theirs'} kind-${message.kind}`} key={message.id}>
                <div className="chat-message-meta"><strong>{mine ? 'You' : sender}</strong><time>{formatTimestamp(message.createdAt)}</time></div>
                <div className="chat-bubble">
                  {message.kind === 'text' && <p>{message.text}</p>}
                  {message.kind === 'sticker' && <StickerArt stickerId={message.stickerId} large />}
                  {message.kind === 'image' && (
                    <button className="chat-image" onClick={() => setPreview(message)} aria-label={`Preview image shared by ${mine ? 'you' : sender}`}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={message.objectUrl} alt={`Shared image from ${mine ? 'you' : sender}`} width={message.width} height={message.height} />
                    </button>
                  )}
                </div>
                <div className="message-reaction-row" aria-label="Message reactions">
                  {MESSAGE_REACTIONS.slice(0, 3).map((reaction) => {
                    const existing = message.reactions.find((item) => item.reaction === reaction);
                    const active = existing?.playerIds.includes(selfId);
                    return (
                      <button
                        key={reaction}
                        className={active ? 'is-active' : ''}
                        onClick={() => onMessageReaction(message.id, reaction)}
                        disabled={!canChat}
                        aria-label={`${active ? 'Remove' : 'Add'} ${reaction} reaction`}
                        aria-pressed={active}
                      >
                        {reaction}{existing && <span>{existing.playerIds.length}</span>}
                      </button>
                    );
                  })}
                </div>
              </article>
            );
          })}
        </div>

        {newMessages && <button className="new-message-button" onClick={scrollToLatest}>New messages ↓</button>}
        <div className="typing-line" aria-live="polite">
          {typingPlayer ? <><span /><b>{typingPlayer.name}</b> is typing…</> : <span className="typing-placeholder">Private signal ready</span>}
        </div>

        <div className="quick-reaction-row" aria-label="Quick game reactions">
          <span>REACT</span>
          {QUICK_REACTIONS.map((reaction) => (
            <button key={reaction} onClick={() => onQuickReaction(reaction)} disabled={!canChat} aria-label={`Send ${reaction} reaction`}>{reaction}</button>
          ))}
        </div>

        <form className="chat-composer" onSubmit={submit}>
          <div className="composer-tools" ref={pickerRef}>
            <button type="button" className={picker === 'emoji' ? 'is-active' : ''} onClick={() => setPicker((current) => current === 'emoji' ? null : 'emoji')} aria-label="Open emoji picker" aria-expanded={picker === 'emoji'}>☺</button>
            <button type="button" className={picker === 'sticker' ? 'is-active' : ''} onClick={() => setPicker((current) => current === 'sticker' ? null : 'sticker')} aria-label="Open sticker picker" aria-expanded={picker === 'sticker'}>◇</button>
            <button type="button" onClick={() => fileInputRef.current?.click()} disabled={!canChat || imagePreparing} aria-label="Share an image">{imagePreparing ? '…' : '⌁'}</button>
            <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={handleFile} tabIndex={-1} aria-hidden="true" />
            {picker && (
              <div className={`chat-picker picker-${picker}`} role="dialog" aria-label={picker === 'emoji' ? 'Emoji picker' : 'Sticker picker'}>
                <div className="picker-tabs" role="tablist">
                  <button type="button" role="tab" aria-selected={picker === 'emoji'} onClick={() => setPicker('emoji')}>Emoji</button>
                  <button type="button" role="tab" aria-selected={picker === 'sticker'} onClick={() => setPicker('sticker')}>Stickers</button>
                </div>
                {picker === 'emoji' ? (
                  <div className="emoji-grid">{EMOJIS.map((emoji) => <button type="button" key={emoji} onClick={() => insertEmoji(emoji)} aria-label={`Insert ${emoji}`}>{emoji}</button>)}</div>
                ) : (
                  <div className="sticker-grid">{STICKER_IDS.map((stickerId) => <button type="button" key={stickerId} onClick={() => { if (onSticker(stickerId)) setPicker(null); }} aria-label={`Send ${stickerLabel(stickerId)} sticker`}><StickerArt stickerId={stickerId} /></button>)}</div>
                )}
              </div>
            )}
          </div>
          <label className="composer-input">
            <span className="sr-only">Message</span>
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(event) => handleTextChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={players.length < 2 ? 'Waiting for opponent…' : 'Message the room…'}
              maxLength={MAX_CHAT_TEXT_LENGTH}
              rows={1}
              disabled={!canChat}
            />
          </label>
          <button className="chat-send" disabled={!canChat || !text.trim()} aria-label="Send message">↗</button>
        </form>
        {imagePreparing && <div className="image-preparing" role="status"><span /> Preparing image…</div>}
      </aside>

      {activePreview && (
        <div className="image-preview" role="dialog" aria-modal="true" aria-label="Shared image preview" onClick={() => setPreview(null)}>
          <button onClick={() => setPreview(null)} aria-label="Close image preview">×</button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={activePreview.objectUrl} alt="Shared image preview" onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </>
  );
}

function StickerArt({ stickerId, large = false }: { stickerId: StickerId; large?: boolean }) {
  return (
    <span
      className={`sticker-art sticker-${stickerId} ${large ? 'is-large' : ''}`}
      style={{ backgroundImage: `url("${ASSET_BASE_PATH}/stickers/gridline-stickers.webp")` }}
      role="img"
      aria-label={`${stickerLabel(stickerId)} sticker`}
    />
  );
}

function stickerLabel(stickerId: StickerId): string {
  return stickerId === 'mind-blown' ? 'mind blown' : stickerId;
}

function formatTimestamp(timestamp: number): string {
  return `${new Date(timestamp).toISOString().slice(11, 16)} UTC`;
}
