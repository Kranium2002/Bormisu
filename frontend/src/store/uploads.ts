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

/** Where one file of the upload queue is. */
export type UploadStatus = 'queued' | 'uploading' | 'done' | 'failed' | 'cancelled';

/** One file in the upload queue (F6). */
export interface UploadItem {
  /** Id of the queue entry in this browser (not a server id). */
  id: string;
  name: string;
  /** Size of the file in bytes. */
  size: number;
  /** Project label sent with the file; null when none was typed or dropped. */
  project: string | null;
  status: UploadStatus;
  /** Bytes sent so far and in all, as the source reports them (the file size until it does). */
  loaded: number;
  total: number;
  /** The document the server answered with; null until then. */
  documentId: string | null;
  /** Why the upload failed; null otherwise. */
  error: string | null;
  /** The server had these bytes already: `documentId` is that earlier upload. */
  duplicate: boolean;
}

/** Uploads that run at the same time; the rest wait in the queue. */
export const MAX_PARALLEL_UPLOADS = 2;

/** True once an upload can't change any more (it can be removed from the list). */
export function isFinishedUpload(item: Pick<UploadItem, 'status'>): boolean {
  return item.status === 'done' || item.status === 'failed' || item.status === 'cancelled';
}

/** The path of a file inside a folder chosen with a folder picker; '' for a file chosen on its own. */
const relativePath = (f: File): string => (typeof f.webkitRelativePath === 'string' ? f.webkitRelativePath : '');

/**
 * The folder chosen with a folder picker: the first segment of the files' `webkitRelativePath`
 * when they all share one; null for files chosen one by one.
 */
export function pickedFolder(files: File[]): string | null {
  const roots = new Set(files.map((f) => (relativePath(f).includes('/') ? relativePath(f).split('/')[0] : '')));
  const [root] = roots;
  return roots.size === 1 && root ? root : null;
}

/** The project sent with files dropped together: the label the user typed, else the dropped folder's name, else none. */
export function uploadProject(typed: string, folder: string | null | undefined): string | null {
  return typed.trim() || folder?.trim() || null;
}

/** "12.4 MB", "830 kB", "512 B" (decimal units, as file managers show them). */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${Math.round(n / 1000)} kB`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  return `${(n / 1_000_000_000).toFixed(2)} GB`;
}

/** Percent of an upload sent, 0–100; a finished upload is 100. */
export function uploadPercent(item: Pick<UploadItem, 'status' | 'loaded' | 'total'>): number {
  if (item.status === 'done') return 100;
  return item.total > 0 ? Math.min(100, Math.round((item.loaded / item.total) * 100)) : 0;
}

/** "2 uploading · 1 waiting · 3 done": the queue in one line, for the list header and screen readers. */
export function uploadSummary(items: Pick<UploadItem, 'status'>[]): string {
  const count = (s: UploadStatus) => items.filter((i) => i.status === s).length;
  const parts: [number, string][] = [
    [count('uploading'), 'uploading'],
    [count('queued'), 'waiting'],
    [count('done'), 'done'],
    [count('failed'), 'failed'],
    [count('cancelled'), 'cancelled'],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(' · ');
}
