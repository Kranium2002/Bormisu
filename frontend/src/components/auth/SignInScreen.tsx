import { useEffect, useRef, useState, type FormEvent } from 'react';
import { APP_NAME } from '../../config';
import { SESSION_ENDED } from '../../store/authSlice';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/appStore';
import styles from './Auth.module.css';
import { PasswordField, PasswordRules, TextField } from './AuthFields';
import {
  DISPLAY_NAME_MAX,
  EMAIL_MAX,
  PASSWORD_RULES,
  validateRegister,
  validateSignIn,
  type AuthField,
  type FieldErrors,
} from './authRules';

export type SignInMode = 'signIn' | 'register';

/** Field order of each form: the focus goes to the first invalid one. */
const ORDER: Record<SignInMode, AuthField[]> = {
  signIn: ['email', 'password'],
  register: ['email', 'display_name', 'password', 'repeat'],
};

/**
 * The sign-in screen (contract 1.3.0), shown instead of the app while no user is signed in; the URL
 * stays, so the user returns to it after signing in. SIGN IN, and CREATE ACCOUNT when the server's
 * registration is open (the first account becomes admin). Errors show next to their fields and on
 * top (role=alert); the form checks lengths and the repeated password before sending, the server
 * judges the rest.
 */
export function SignInScreen({ initialMode = 'signIn' }: { initialMode?: SignInMode }) {
  const t = useT();
  const registrationOpen = useAppStore((s) => s.health?.auth.registration === 'open');
  const busy = useAppStore((s) => s.authBusy);
  const authError = useAppStore((s) => s.authError);
  const serverErrors = useAppStore((s) => s.authFieldErrors);
  const signIn = useAppStore((s) => s.signIn);
  const register = useAppStore((s) => s.register);
  const clearAuthErrors = useAppStore((s) => s.clearAuthErrors);

  const [mode, setMode] = useState<SignInMode>(initialMode === 'register' && registrationOpen ? 'register' : 'signIn');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [clientErrors, setClientErrors] = useState<FieldErrors>({});

  const refs = {
    email: useRef<HTMLInputElement>(null),
    display_name: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
    repeat: useRef<HTMLInputElement>(null),
  };
  const focusFirst = (errors: Partial<Record<string, string>>) => {
    const first = ORDER[mode].find((f) => errors[f]);
    if (first && first in refs) refs[first as keyof typeof refs].current?.focus();
  };

  // The screen opens with the focus in the email field.
  useEffect(() => {
    refs.email.current?.focus();
  }, []);

  // The server's field errors (a 422, email_taken) move the focus to the first field they name.
  useEffect(() => {
    if (Object.keys(serverErrors).length) focusFirst(serverErrors);
    // Only a new set of server errors moves the focus (focusFirst reads the current mode).
  }, [serverErrors]);

  // Registration closed meanwhile (health read again): back to signing in.
  const shownMode: SignInMode = mode === 'register' && !registrationOpen ? 'signIn' : mode;
  const errors: FieldErrors = { ...(serverErrors as FieldErrors), ...clientErrors };
  const clientInvalid = Object.keys(clientErrors).length > 0;
  const topMessage = clientInvalid ? 'Check the fields marked below.' : authError;
  const sessionNotice = !clientInvalid && authError === SESSION_ENDED;

  /** Edits a field: its own client error goes; the server's errors stay until the next submit. */
  const edit = (field: AuthField, set: (v: string) => void) => (value: string) => {
    set(value);
    if (clientErrors[field]) {
      setClientErrors((prev) => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
    }
  };

  const switchMode = (next: SignInMode) => {
    setMode(next);
    setClientErrors({});
    setPassword('');
    setRepeat('');
    clearAuthErrors();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const found =
      shownMode === 'signIn' ? validateSignIn(email, password) : validateRegister({ email, displayName, password, repeat });
    setClientErrors(found);
    if (Object.keys(found).length) {
      clearAuthErrors();
      focusFirst(found);
      return;
    }
    if (shownMode === 'signIn') void signIn(email.trim(), password);
    else void register({ email: email.trim(), password, displayName: displayName.trim() || null });
  };

  const title = shownMode === 'signIn' ? 'SIGN IN' : 'CREATE ACCOUNT';
  return (
    <div className={styles.page}>
      <main className={styles.card} aria-labelledby="auth-app-name">
        <div className={styles.brand}>
          <img className={styles.logo} src={`${import.meta.env.BASE_URL}logo.png`} width="40" height="40" alt="" />
          <h1 id="auth-app-name" className={styles.appName}>
            {APP_NAME}
          </h1>
        </div>
        <h2 className={styles.modeTitle}>{t(title)}</h2>
        {topMessage && (
          <div role="alert" className={`${styles.alert} ${sessionNotice ? styles.notice : ''}`}>
            {t(topMessage)}
          </div>
        )}
        <form className={styles.form} noValidate aria-busy={busy} aria-label={t(title)} onSubmit={submit}>
          <TextField
            ref={refs.email}
            label={t('EMAIL')}
            name="email"
            type="email"
            autoComplete="email"
            maxLength={EMAIL_MAX}
            value={email}
            onChange={edit('email', setEmail)}
            error={errors.email}
            readOnly={busy}
          />
          {shownMode === 'register' && (
            <TextField
              ref={refs.display_name}
              label={t('DISPLAY NAME')}
              name="display_name"
              autoComplete="name"
              value={displayName}
              onChange={edit('display_name', setDisplayName)}
              error={errors.display_name}
              hint={`Optional. Shown with your reviews. At most ${DISPLAY_NAME_MAX} characters.`}
              readOnly={busy}
            />
          )}
          <PasswordField
            ref={refs.password}
            label={t('PASSWORD')}
            name="password"
            autoComplete={shownMode === 'signIn' ? 'current-password' : 'new-password'}
            value={password}
            onChange={edit('password', setPassword)}
            error={errors.password}
            hint={shownMode === 'register' ? <PasswordRules rules={PASSWORD_RULES} /> : undefined}
            readOnly={busy}
          />
          {shownMode === 'register' && (
            <PasswordField
              ref={refs.repeat}
              label={t('REPEAT PASSWORD')}
              name="repeat"
              autoComplete="new-password"
              value={repeat}
              onChange={edit('repeat', setRepeat)}
              error={errors.repeat}
              readOnly={busy}
            />
          )}
          <button type="submit" className={styles.primary} disabled={busy}>
            {t(busy ? (shownMode === 'signIn' ? 'SIGNING IN…' : 'CREATING ACCOUNT…') : title)}
          </button>
        </form>
        {registrationOpen && (
          <div className={styles.switch}>
            {shownMode === 'signIn' ? (
              <>
                {t('No account yet?')}{' '}
                <button type="button" className={styles.link} onClick={() => switchMode('register')} disabled={busy}>
                  {t('Create an account')}
                </button>
              </>
            ) : (
              <>
                {t('Have an account?')}{' '}
                <button type="button" className={styles.link} onClick={() => switchMode('signIn')} disabled={busy}>
                  {t('Sign in')}
                </button>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
