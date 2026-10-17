/**
 * Sign-in form rules (contract 1.3.0, minimal auth). The server is the judge; these checks only
 * spare a round trip for what the form can see: required fields, lengths, the repeated password.
 *
 * Field keys are the server's field names (a 422's `loc`), so client and server errors show in the
 * same place; `repeat` is the form's own.
 */
export const EMAIL_MAX = 254;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const DISPLAY_NAME_MAX = 80;

/** The rules shown under a new password. */
export const PASSWORD_RULES = [`${PASSWORD_MIN} to ${PASSWORD_MAX} characters`] as const;

export type AuthField = 'email' | 'password' | 'display_name' | 'repeat';
export type FieldErrors = Partial<Record<AuthField, string>>;

/** The email as the server stores it: trimmed and lower-cased. */
export const normaliseEmail = (email: string) => email.trim().toLowerCase();

function emailError(email: string): string | undefined {
  const e = email.trim();
  if (!e) return 'Enter your email.';
  if (e.length > EMAIL_MAX) return `At most ${EMAIL_MAX} characters.`;
  if (!/^[^\s@]+@[^\s@]+$/.test(e)) return 'Enter an email address such as name@example.com.';
  return undefined;
}

/** Checks a new password's length. */
export function newPasswordError(password: string): string | undefined {
  if (!password) return 'Enter a password.';
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  return undefined;
}

function compact(errors: FieldErrors): FieldErrors {
  const out: FieldErrors = {};
  for (const [k, v] of Object.entries(errors) as [AuthField, string | undefined][]) if (v) out[k] = v;
  return out;
}

export function validateSignIn(email: string, password: string): FieldErrors {
  return compact({ email: emailError(email), password: password ? undefined : 'Enter your password.' });
}

export function validateRegister(f: { email: string; displayName: string; password: string; repeat: string }): FieldErrors {
  return compact({
    email: emailError(f.email),
    display_name: f.displayName.trim().length > DISPLAY_NAME_MAX ? `At most ${DISPLAY_NAME_MAX} characters.` : undefined,
    password: newPasswordError(f.password),
    repeat: f.repeat === f.password ? undefined : 'The passwords do not match.',
  });
}
