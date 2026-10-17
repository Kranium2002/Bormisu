import type { CSSProperties } from 'react';
import { PAGE_W, type DocumentSummary, type Evidence } from '../../domain/types';
import { useAppStore, usePage, type PageLoad } from '../../store/appStore';
import { ScanPage, type ScanBox } from '../ScanPage';
import { OriginalLabel } from '../SideLabel';
import styles from './Clarify.module.css';
import { evidencePages, type EvidencePage } from './clarifyModel';

/** Width of a page in the evidence pane (px). */
const PANE_PAGE_W = 420;

/** A document that has no page images: it is processed and lists no pages (a spreadsheet, a data file). */
export function hasNoPages(doc: Pick<DocumentSummary, 'pages' | 'step'> | undefined): boolean {
  return !!doc && doc.pages.length === 0 && doc.step >= 2;
}

interface PageViewProps {
  page: EvidencePage;
  load: PageLoad;
  /** File name when the page is in another document than the question's, else null. */
  otherFile: string | null;
  /** File name of the page's document when the store has it (named in the ORIGINAL caption). */
  fileName?: string | null;
  /** The document has no page images (e.g. a spreadsheet). */
  noPages: boolean;
}

/**
 * One evidence page with its boxes highlighted, or why it can't be shown (pure; rendered in tests).
 * Its caption says it is the original as uploaded.
 */
export function EvidencePageView({ page, load, otherFile, fileName, noPages }: PageViewProps) {
  const title = `Page ${page.page}${otherFile ? ` · ${otherFile}` : ''}`;
  const boxes: ScanBox[] = page.boxes.map((box, i) => ({
    id: `ev${i}`,
    box,
    // One box dims the rest of the page; several are outlined so none hides another.
    variant: page.boxes.length === 1 ? 'highlight' : 'focus',
    title: page.snippets[i] ?? undefined,
  }));
  const snippets = page.snippets.filter((s): s is string => !!s);
  let body;
  if (noPages) {
    body = <div className={styles.pageNote}>No page image: this document has no pages (for example a spreadsheet).</div>;
  } else if (load.status === 'ready') {
    body = (
      <div className={styles.pageClip}>
        <ScanPage content={load.content} boxes={boxes} scale={PANE_PAGE_W / PAGE_W} />
      </div>
    );
  } else if (load.status === 'loading') {
    body = <div className={styles.pageNote}>Loading page {page.page}…</div>;
  } else {
    body = (
      <div className={`${styles.pageNote} ${styles.pageNoteError}`}>
        Page {page.page} can’t be shown: {load.error}
      </div>
    );
  }
  return (
    <figure className={styles.evPage} aria-label={title}>
      <figcaption className={styles.evCaption}>
        <span className={styles.evTitle}>
          <OriginalLabel file={otherFile ?? fileName} page={page.page} />
        </span>
        {snippets.length > 0 && <span className={styles.evSnippet}>“{snippets.join('” · “')}”</span>}
        {load.status === 'ready' && !noPages && !page.boxes.length && <span className={styles.evNoBox}>no box on this page</span>}
      </figcaption>
      {body}
    </figure>
  );
}

/** One evidence page, loaded through the page cache. */
function EvidencePageItem({ page, questionDocumentId }: { page: EvidencePage; questionDocumentId: string }) {
  const doc = useAppStore((s) => s.documents.find((d) => d.id === page.documentId));
  const noPages = hasNoPages(doc);
  const load = usePage(noPages ? null : page.documentId, page.page);
  const otherFile = page.documentId === questionDocumentId ? null : (doc?.name ?? 'another document');
  return <EvidencePageView page={page} load={load} otherFile={otherFile} fileName={doc?.name} noPages={noPages} />;
}

/**
 * Left side of the question dialog: the pages the backend cites, each with its boxes highlighted
 * (page images in API mode, drawn pages in sample mode), and their text as printed.
 */
export function EvidencePane({ evidence, documentId }: { evidence: readonly Evidence[]; documentId: string }) {
  const pages = evidencePages(evidence);
  return (
    <section className={styles.evidence} aria-label="Evidence">
      {pages.length === 0 && <div className={styles.pageNote}>The backend cites no page for this question.</div>}
      {pages.map((p) => (
        <EvidencePageItem key={`${p.documentId}:${p.page}`} page={p} questionDocumentId={documentId} />
      ))}
    </section>
  );
}

/* ---------- crops (choose_reading cards) ---------- */

interface CropProps {
  evidence: Evidence;
  load: PageLoad;
  width?: number;
  height?: number;
}

/**
 * The part of a page around one evidence box, the box outlined (pure; rendered in tests). The page
 * is scaled so the box takes about half the crop's width and is centred in it.
 */
export function EvidenceCropView({ evidence, load, width = 220, height = 64 }: CropProps) {
  const size: CSSProperties = { width, height };
  const label = `Page ${evidence.page}${evidence.snippet ? `: “${evidence.snippet}”` : ''}`;
  if (load.status !== 'ready') {
    return (
      <span className={styles.cropNote} style={size}>
        {load.status === 'loading' ? `Loading page ${evidence.page}…` : `Page ${evidence.page} can’t be shown`}
      </span>
    );
  }
  const box = evidence.box;
  if (!box) {
    return (
      <span className={styles.cropNote} style={size}>
        {label}, no box
      </span>
    );
  }
  const pageWidth = Math.min(PAGE_W * 4, Math.max(width, (0.5 * width) / Math.max(box.w, 0.01)));
  const cx = (box.x + box.w / 2) * 100;
  const cy = (box.y + box.h / 2) * 100;
  return (
    <span className={styles.crop} style={size} role="img" aria-label={label}>
      <span className={styles.cropInner} style={{ transform: `translate(-${cx}%, -${cy}%)` }} aria-hidden="true">
        <ScanPage content={load.content} boxes={[{ id: 'crop', box, variant: 'focus' }]} scale={pageWidth / PAGE_W} />
      </span>
    </span>
  );
}

/** An evidence crop loaded through the page cache. */
export function EvidenceCrop({ evidence, width, height }: Omit<CropProps, 'load'>) {
  const load = usePage(evidence.documentId, evidence.page);
  return <EvidenceCropView evidence={evidence} load={load} width={width} height={height} />;
}
