import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { User } from '../../domain/types';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/appStore';
import styles from '../auth/Auth.module.css';
import { Popover } from '../Popover';
import { ReviewerName } from '../ReviewerName';

const ROLE_TEXT: Record<User['role'], string> = { reviewer: 'REVIEWER', admin: 'ADMIN' };

/** What the header button shows: the display name, else the email. */
export const userLabel = (u: Pick<User, 'displayName' | 'email'>) => u.displayName ?? u.email;

/**
 * The header's identity control. Signed in (contract 1.3.0): a button with the user's name opening
 * a small menu with the email, the role and SIGN OUT. Without sign-in on the server
 * (and in sample mode): the optional "Your name" setting, as before. Nothing while it is unknown.
 */
export function UserMenu() {
  const authState = useAppStore((s) => s.authState);
  const user = useAppStore((s) => s.user);
  if (authState === 'signedIn' && user) return <SignedInMenu user={user} />;
  if (authState === 'disabled') return <ReviewerName />;
  return null;
}

/** The signed-in user's button and menu. Escape or a click outside closes the menu. */
export function SignedInMenu({ user }: { user: User }) {
  const t = useT();
  const signOut = useAppStore((s) => s.signOut);
  const busy = useAppStore((s) => s.authBusy);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && e.target instanceof Node && !wrap.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !open) return;
    // Closes only this menu, not the overlays behind it.
    e.stopPropagation();
    setOpen(false);
    button.current?.focus();
  };

  const label = userLabel(user);
  return (
    <div ref={wrap} className={styles.userWrap} onKeyDown={onKey}>
      <button
        ref={button}
        type="button"
        className={styles.userButton}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Signed in as ${user.email}`}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      {open && (
        <Popover width={260} top={44} label="Account">
          <div className={styles.menu}>
            <div>
              {user.displayName && <div className={styles.menuName}>{user.displayName}</div>}
              <div className={styles.menuEmail}>{user.email}</div>
              <div className={styles.menuRole}>{t(ROLE_TEXT[user.role])}</div>
            </div>
            <button type="button" className={styles.menuItem} disabled={busy} onClick={() => void signOut()}>
              {t(busy ? 'SIGNING OUT…' : 'SIGN OUT')}
            </button>
          </div>
        </Popover>
      )}
    </div>
  );
}
