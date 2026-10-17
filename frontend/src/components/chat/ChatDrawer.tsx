/**
 * The chat drawer (FRONTEND.md F14): on the right, over the map and the other screens (a full-screen
 * sheet on narrow screens). The transcript streams the assistant's answer (ChatMessages), a STOP
 * button ends a running answer, and a failed answer shows the error with RETRY. Under the transcript:
 * the hint of a request_area (or the area drawn for the next message), the include-unreviewed switch,
 * "This map area" (the visible map goes with the next messages; on the map only) and the input.
 *
 * The conversation is the app's one AI SDK chat (src/chat/session.ts), so it survives closing the
 * drawer and changing screens. When the server has no chat model (health, or a 409 chat_unavailable),
 * the drawer says so and the input is off. Loaded on demand (the AI SDK is a chunk of its own).
 */
import { useChat } from '@ai-sdk/react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { answerQuestion, openCitation, openSetTable, showSetOnMap } from '../../chat/cardActions';
import { viewOffReason } from '../../chat/context';
import { getChat, shownMapSize } from '../../chat/session';
import { isChatUnavailable } from '../../chat/transport';
import { chatErrorText, chatOffReason, CHAT_BUTTON_ID, CHAT_NOT_CONFIGURED } from '../../chat/view';
import { dataSourceKind } from '../../data/createDataSource';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/appStore';
import { Toggle } from '../Toggle';
import styles from './Chat.module.css';
import { ChatMessageView, hasContent, type MessageActions } from './ChatMessages';

const ACTIONS: MessageActions = {
  onShowSet: (id) => void showSetOnMap(id),
  onOpenTable: (id) => void openSetTable(id),
  onCite: (c) => void openCitation(c),
  onClarify: answerQuestion,
};

const EMPTY_TEXT =
  'Ask about the uploaded boreholes, for example how many are deeper than 10 m in a town. Answers come from the uploaded reports; numbers come from the database.';

export default function ChatDrawer() {
  const t = useT();
  const chat = getChat();
  const { messages, status, error, sendMessage, stop, regenerate, setMessages, clearError } = useChat({ chat });
  const offReason = useAppStore((s) => chatOffReason(s, dataSourceKind() === 'sample'));
  const includeUnreviewed = useAppStore((s) => s.chatIncludeUnreviewed);
  const setIncludeUnreviewed = useAppStore((s) => s.setChatIncludeUnreviewed);
  const useView = useAppStore((s) => s.chatUseView);
  const setUseView = useAppStore((s) => s.setChatUseView);
  const screen = useAppStore((s) => s.screen);
  const mapView = useAppStore((s) => s.mapView);
  const areaRequest = useAppStore((s) => s.chatAreaRequest);
  const area = useAppStore((s) => s.chatArea);
  const cancelAreaRequest = useAppStore((s) => s.cancelChatAreaRequest);
  const setChatArea = useAppStore((s) => s.setChatArea);
  const closeChat = useAppStore((s) => s.closeChat);
  // The Source panel (600 px on the right) stays visible: the drawer moves to its left.
  const panelOpen = useAppStore((s) => s.panel !== null);
  const [input, setInput] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const busy = status === 'submitted' || status === 'streaming';
  const unavailable = !!error && isChatUnavailable(error);
  const off = offReason ?? (unavailable ? CHAT_NOT_CONFIGURED : null);
  const viewOff = viewOffReason({ screen, mapView }, screen === 'map' && shownMapSize() !== null);
  const sendOff = off ?? (busy ? 'Wait for the answer, or STOP it' : !input.trim() ? 'Type a question first' : null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // The newest content in view (instantly: no smooth scrolling, so reduced motion is respected).
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status, error]);

  const send = () => {
    const text = input.trim();
    if (!text || sendOff) return;
    setInput('');
    void sendMessage({ text });
  };

  const onInputKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const close = () => {
    closeChat();
    document.getElementById(CHAT_BUTTON_ID)?.focus();
  };

  const shown = messages.filter(hasContent);

  return (
    <aside
      className={`${styles.drawer} ${panelOpen ? styles.besidePanel : ''}`}
      aria-label="Chat assistant"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      }}
    >
      <div className={styles.head}>
        <h2 className={styles.title}>{t('CHAT')}</h2>
        <button
          type="button"
          className={styles.headButton}
          aria-disabled={busy || messages.length === 0 ? true : undefined}
          title={t(busy ? 'Wait for the answer, or STOP it' : messages.length === 0 ? 'Nothing to clear yet' : 'Start a new conversation')}
          onClick={() => {
            if (busy || !messages.length) return;
            setMessages([]);
            clearError();
          }}
        >
          {t('NEW CHAT')}
        </button>
        <button type="button" className={styles.close} aria-label="Close the chat" title={t('Close the chat (Esc)')} onClick={close}>
          ×
        </button>
      </div>

      {off && (
        <div className={styles.off} role="status">
          {t(off)}
        </div>
      )}

      <div ref={logRef} className={styles.log} role="log" aria-live="polite" aria-label="Conversation">
        {shown.length === 0 && !off && <p className={styles.empty}>{t(EMPTY_TEXT)}</p>}
        {shown.map((m) => (
          <ChatMessageView key={m.id} message={m} actions={ACTIONS} />
        ))}
        {status === 'submitted' && <div className={styles.thinking}>{t('Thinking…')}</div>}
        {error && !unavailable && (
          <div className={styles.error} role="alert">
            <span>{chatErrorText(error)}</span>
            <button type="button" className={styles.secondary} onClick={() => void regenerate()}>
              {t('RETRY')}
            </button>
          </div>
        )}
      </div>

      <div className={styles.foot}>
        {areaRequest && (
          <div className={styles.area} role="status">
            <span>
              <strong>{t('Draw the area on the map.')}</strong> {areaRequest.prompt}
            </span>
            <button type="button" className={styles.linkButton} onClick={cancelAreaRequest}>
              {t('CANCEL')}
            </button>
          </div>
        )}
        {area && !areaRequest && (
          <div className={styles.area} role="status">
            <span>{t('Area drawn on the map: it goes with your next message.')}</span>
            <button type="button" className={styles.linkButton} onClick={() => setChatArea(null)}>
              {t('REMOVE')}
            </button>
          </div>
        )}
        <div className={styles.options}>
          <label className={styles.option} htmlFor="chat-include-unreviewed">
            {t('Include unreviewed')}
          </label>
          <Toggle id="chat-include-unreviewed" on={includeUnreviewed} onToggle={() => setIncludeUnreviewed(!includeUnreviewed)} />
          <button
            type="button"
            className={`${styles.chip} ${useView && !viewOff ? styles.chipOn : ''}`}
            aria-pressed={useView && !viewOff}
            aria-disabled={viewOff ? true : undefined}
            title={t(viewOff ?? 'Ask about the area the map shows: it goes with your next messages')}
            onClick={() => {
              if (!viewOff) setUseView(!useView);
            }}
          >
            {t('THIS MAP AREA')}
          </button>
        </div>
        <div className={styles.inputRow}>
          <textarea
            ref={inputRef}
            className={styles.input}
            rows={2}
            value={input}
            disabled={!!off}
            title={off ?? undefined}
            placeholder={off ? t('Chat is off') : `${t('Ask about the boreholes…')}  ⏎`}
            aria-label="Your question"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onInputKey}
          />
          {busy ? (
            <button type="button" className={styles.stop} onClick={() => void stop()}>
              {t('STOP')}
            </button>
          ) : (
            <button type="button" className={styles.primary} aria-disabled={sendOff ? true : undefined} title={t(sendOff ?? 'Send (Enter)')} onClick={send}>
              {t('SEND')}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
