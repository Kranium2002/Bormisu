/**
 * Upload rules from the server's health answer: accepted extensions, size limit and demo mode.
 * Nothing here is hard-coded: without a health answer every file goes to the source, which refuses
 * what the server doesn't take.
 */
import type { Health } from '../domain/types';

/** Why uploads are off in demo mode (the backend has no provider keys). */
export const DEMO_UPLOAD_REASON = 'Live extraction needs API keys';

/** Lower-case extension with its dot, e.g. ".pdf"; '' when the name has none. */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** Why uploading is not possible at all, or null. */
export function uploadBlockedReason(health: Health | null): string | null {
  return health?.mode === 'demo' ? DEMO_UPLOAD_REASON : null;
}

/**
 * Why RETRY of a failed document is not possible, or null. In demo mode the backend accepts a retry
 * but has no provider to run it with, so the document would stall; sample and live modes retry.
 */
export function retryBlockedReason(health: Health | null): string | null {
  return health?.mode === 'demo' ? DEMO_UPLOAD_REASON : null;
}

export interface UploadCheck {
  accepted: File[];
  /** Explains the refused files; '' when every file is accepted. */
  error: string;
}

/** Splits files into the ones the server accepts and an error naming the rest (type, then size). */
export function checkUploads(files: File[], limits: Health['upload'] | null): UploadCheck {
  if (!limits) return { accepted: files, error: '' };
  const allowed = new Set(limits.extensions.map((e) => e.toLowerCase()));
  const maxBytes = limits.maxMb * 1024 * 1024;
  const wrongType = files.filter((f) => !allowed.has(fileExtension(f.name)));
  const tooLarge = files.filter((f) => allowed.has(fileExtension(f.name)) && f.size > maxBytes);
  const errors = [
    wrongType.length ? `File type not supported: ${wrongType.map((f) => f.name).join(', ')}` : '',
    tooLarge.length ? `Larger than ${limits.maxMb} MB: ${tooLarge.map((f) => f.name).join(', ')}` : '',
  ].filter(Boolean);
  return { accepted: files.filter((f) => !wrongType.includes(f) && !tooLarge.includes(f)), error: errors.join(' · ') };
}

/** The file chooser's accept attribute, or undefined when the limits are unknown. */
export function acceptAttribute(limits: Health['upload'] | null): string | undefined {
  return limits?.extensions.length ? limits.extensions.join(',') : undefined;
}

/** Drop-zone line with the accepted types and the size limit, e.g. "PDF, DOCX, PNG · up to 200 MB each". */
export function uploadHint(limits: Health['upload'] | null): string {
  if (!limits) return 'or click to choose files';
  const types = limits.extensions.map((e) => e.replace(/^\./, '').toUpperCase()).join(', ');
  return `or click to choose files · ${types} · up to ${limits.maxMb} MB each`;
}
