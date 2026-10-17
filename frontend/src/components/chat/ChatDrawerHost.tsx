import { lazy, Suspense } from 'react';
import { useAppStore } from '../../store/appStore';

/** The drawer and the AI SDK are a chunk of their own, loaded the first time the chat opens. */
const ChatDrawer = lazy(() => import('./ChatDrawer'));

/**
 * The chat drawer, mounted once in the app shell (FRONTEND.md F14): shown while the chat is open, over
 * whatever screen is shown. The conversation lives on when the drawer closes (src/chat/session.ts).
 */
export function ChatDrawerHost() {
  const open = useAppStore((s) => s.chatOpen);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <ChatDrawer />
    </Suspense>
  );
}
