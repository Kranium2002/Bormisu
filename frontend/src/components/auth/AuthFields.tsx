import { forwardRef, useId, useState, type ReactNode } from 'react';
import styles from './Auth.module.css';

interface FieldProps {
  label: string;
  value: string;
  onChange(value: string): void;
  error?: string;
  /** Text under the field (rules, "optional"), linked with aria-describedby. */
  hint?: ReactNode;
  autoComplete: string;
  name: string;
  /** While a request runs: the value can't change, the focus stays. */
  readOnly?: boolean;
}

/** A labelled text input with its error next to it (aria-invalid, aria-describedby). */
export const TextField = forwardRef<HTMLInputElement, FieldProps & { type?: 'email' | 'text'; maxLength?: number }>(
  function TextField({ label, value, onChange, error, hint, autoComplete, name, readOnly, type = 'text', maxLength }, ref) {
    const id = useId();
    const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
    return (
      <div className={styles.field}>
        <label className={styles.label} htmlFor={id}>
          {label}
        </label>
        <input
          ref={ref}
          id={id}
          name={name}
          type={type}
          className={`${styles.input} ${error ? styles.invalid : ''}`}
          value={value}
          autoComplete={autoComplete}
          maxLength={maxLength}
          spellCheck={false}
          autoCapitalize="none"
          readOnly={readOnly}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        />
        {hint && (
          <div id={`${id}-hint`} className={styles.hint}>
            {hint}
          </div>
        )}
        {error && (
          <div id={`${id}-error`} className={styles.fieldError}>
            {error}
          </div>
        )}
      </div>
    );
  },
);

/** A password input with a show / hide toggle (its accessible name says which). */
export const PasswordField = forwardRef<HTMLInputElement, FieldProps>(function PasswordField(
  { label, value, onChange, error, hint, autoComplete, name, readOnly },
  ref,
) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <div className={styles.passwordRow}>
        <input
          ref={ref}
          id={id}
          name={name}
          type={shown ? 'text' : 'password'}
          className={`${styles.input} ${styles.passwordInput} ${error ? styles.invalid : ''}`}
          value={value}
          autoComplete={autoComplete}
          spellCheck={false}
          autoCapitalize="none"
          readOnly={readOnly}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className={styles.toggle}
          aria-label={`${shown ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
          aria-controls={id}
          onClick={() => setShown((s) => !s)}
        >
          {shown ? 'HIDE' : 'SHOW'}
        </button>
      </div>
      {hint && (
        <div id={`${id}-hint`} className={styles.hint}>
          {hint}
        </div>
      )}
      {error && (
        <div id={`${id}-error`} className={styles.fieldError}>
          {error}
        </div>
      )}
    </div>
  );
});

/** The rules of a new password, shown under the field. */
export function PasswordRules({ rules }: { rules: readonly string[] }) {
  return (
    <ul className={styles.rules}>
      {rules.map((r) => (
        <li key={r}>{r}</li>
      ))}
    </ul>
  );
}
