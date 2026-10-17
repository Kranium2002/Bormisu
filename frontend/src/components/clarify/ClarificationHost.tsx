import { createPortal } from 'react-dom';
import { useAppStore } from '../../store/appStore';
import { ClarificationDialog } from './ClarificationDialog';

/**
 * Mounts the question dialog over whatever screen is shown while a question is open
 * (activeClarificationId), in document.body, so the inbox, a document card, Review and the chat all
 * open the same dialog. Rendered once in the app shell.
 */
export function ClarificationHost() {
  const open = useAppStore((s) => !!s.activeClarificationId);
  if (!open || typeof document === 'undefined') return null;
  return createPortal(<ClarificationDialog />, document.body);
}
