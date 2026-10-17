import { chatOffReason, CHAT_BUTTON_ID } from '../../chat/view';
import { dataSourceKind } from '../../data/createDataSource';
import { useAppStore } from '../../store/appStore';
import styles from '../chat/Chat.module.css';

/** The header button's view, from props (server-rendered in tests). */
export function ChatButtonView({ open, offReason, onToggle }: { open: boolean; offReason: string | null; onToggle(): void }) {
  // Off with the reason as its tooltip; still focusable (aria-disabled), so keyboard users get the reason too.
  // An open drawer can always be closed from here.
  const off = !open && offReason !== null;
  return (
    <div className={styles.buttonWrap}>
      <button
        type="button"
        id={CHAT_BUTTON_ID}
        className={`${styles.headerButton} ${open ? styles.headerButtonOpen : ''}`}
        aria-expanded={open}
        aria-disabled={off ? true : undefined}
        title={off ? offReason : open ? 'Close the chat' : 'Ask the chat assistant'}
        onClick={() => {
          if (!off) onToggle();
        }}
      >
        CHAT
      </button>
    </div>
  );
}

/**
 * Header button that opens and closes the chat drawer (FRONTEND.md F14). Off, with the reason as
 * its tooltip, when the server has no chat model (health providers.chat, or a 409 chat_unavailable)
 * and in sample mode, which has no backend to ask (the chat is never faked).
 */
export function ChatButton() {
  const open = useAppStore((s) => s.chatOpen);
  const offReason = useAppStore((s) => chatOffReason(s, dataSourceKind() === 'sample'));
  const toggleChat = useAppStore((s) => s.toggleChat);
  return <ChatButtonView open={open} offReason={offReason} onToggle={toggleChat} />;
}
