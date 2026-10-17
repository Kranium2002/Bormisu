import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useAppStore } from '../../store/appStore';
import { useFocusTrap } from '../useFocusTrap';
import styles from './Auth.module.css';
import { PasswordField, PasswordRules } from './AuthFields';
import { PASSWORD_RULES, validatePasswordChange, type AuthField, type FieldErrors } from './authRules';

/** Field order of the form: the focus goes to the first invalid one. */
const ORDER: AuthField[] = ['current_password', 'new_password', 'repeat'];

export const PASSWORD_CHANGED = 'Password changed. Your other sessions were signed out.';

/**
 * CHANGE PASSWORD (POST /auth/password): current, new and repeated password. A modal dialog: the focus
 * stays inside (useFocusTrap), Escape, × and a click on the scrim close it. The form checks the
 * lengths, the email and the repeat before sending; the server judges the rest (a common password,
 * a wrong current password). On success the server signs out the user's other sessions; this one
 * stays signed in.
 */
export function ChangePasswordDialog({ onClose, onChanged }: { onClose(): void; onChanged(): void }) {
  const email = useAppStore((s) => s.user?.email ?? null);
  const busy = useAppStore((s) => s.authBusy);
  const authError = useAppStore((s) => s.authError);
  const serverErrors = useAppStore((s) => s.authFieldErrors);
  const changePassword = useAppStore((s) => s.changePassword);
  const clearAuthErrors = useAppStore((s) => s.clearAuthErrors);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [clientErrors, setClientErrors] = useState<FieldErrors>({});
  const dialog = useRef<HTMLDivElement>(null);
  const refs = {
    current_password: useRef<HTMLInputElement>(null),
    new_password: useRef<HTMLInputElement>(null),
    repeat: useRef<HTMLInputElement>(null),
  };
  const focusFirst = (errors: Partial<Record<string, string>>) => {
    const first = ORDER.find((f) => errors[f]);
    if (first && first in refs) refs[first as keyof typeof refs].current?.focus();
  };

  useFocusTrap(dialog);
  // Errors of an earlier attempt (or of the sign-in) never show here; the first field takes the focus.
  useEffect(() => {
    clearAuthErrors();
    refs.current_password.current?.focus();
    // An ended session keeps its message for the sign-in screen.
    return () => {
      if (useAppStore.getState().authState === 'signedIn') clearAuthErrors();
    };
    // Once per opening.
  }, []);
  // The server's field errors (a 422, a wrong current password) move the focus to the first one.
  useEffect(() => {
    if (Object.keys(serverErrors).length) focusFirst(serverErrors);
  }, [serverErrors]);

  const errors: FieldErrors = { ...(serverErrors as FieldErrors), ...clientErrors };
  const topMessage = Object.keys(clientErrors).length ? 'Check the fields marked below.' : authError;

  const edit = (field: AuthField, set: (v: string) => void) => (value: string) => {
    set(value);
    if (clientErrors[field]) {
      setClientErrors((prev) => {
        const copy = { ...prev };
        delete copy[field];
        return copy;
      });
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const found = validatePasswordChange({ current, next, repeat }, email);
    setClientErrors(found);
    if (Object.keys(found).length) {
      clearAuthErrors();
      focusFirst(found);
      return;
    }
    if (await changePassword(current, next)) onChanged();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    // Closes only this dialog, not the overlays behind it.
    e.stopPropagation();
    onClose();
  };

  return (
    <div
      className={styles.scrim}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="change-password-title"
        tabIndex={-1}
        onKeyDown={onKey}
      >
        <div className={styles.dialogHead}>
          <h2 id="change-password-title" className={styles.dialogTitle}>
            CHANGE PASSWORD
          </h2>
          <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {topMessage && (
          <div role="alert" className={styles.alert}>
            {topMessage}
          </div>
        )}
        <form className={styles.form} noValidate aria-busy={busy} aria-label="Change password" onSubmit={submit}>
          <PasswordField
            ref={refs.current_password}
            label="CURRENT PASSWORD"
            name="current_password"
            autoComplete="current-password"
            value={current}
            onChange={edit('current_password', setCurrent)}
            error={errors.current_password}
            readOnly={busy}
          />
          <PasswordField
            ref={refs.new_password}
            label="NEW PASSWORD"
            name="new_password"
            autoComplete="new-password"
            value={next}
            onChange={edit('new_password', setNext)}
            error={errors.new_password}
            hint={<PasswordRules rules={PASSWORD_RULES} />}
            readOnly={busy}
          />
          <PasswordField
            ref={refs.repeat}
            label="REPEAT NEW PASSWORD"
            name="repeat"
            autoComplete="new-password"
            value={repeat}
            onChange={edit('repeat', setRepeat)}
            error={errors.repeat}
            readOnly={busy}
          />
          <p className={styles.hint}>Your other sessions are signed out; this one stays signed in.</p>
          <div className={styles.actions}>
            <button type="submit" className={styles.primary} disabled={busy}>
              {busy ? 'SAVING…' : 'CHANGE PASSWORD'}
            </button>
            <button type="button" className={styles.secondary} onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
