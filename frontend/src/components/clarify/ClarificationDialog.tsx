import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { errorText } from '../../data/errors';
import type { Clarification } from '../../domain/types';
import { useAppStore } from '../../store/appStore';
import { useFocusTrap } from '../useFocusTrap';
import styles from './Clarify.module.css';
import {
  answerValues,
  boreholeText,
  createdText,
  initialInputs,
  kindLabel,
  swapAxesInput,
  type FieldInput,
  type FormInputs,
} from './clarifyModel';
import { EvidencePane } from './EvidencePane';
import { FieldWidget, type CrsCandidatesState, type WidgetContext } from './FieldWidget';
import type { ReferencePoint } from './MapPointPicker';

/** What the server said about the last answer: the message on top and errors next to their fields. */
export interface AnswerOutcome { message: string; fieldErrors: Record<string, string> }

export type DialogBusy = 'answer' | 'skip' | null;

interface ViewProps {
  clarification: Clarification;
  /** File name of the question's document; null when the app has not loaded it. */
  documentName: string | null;
  /** Printed IDs of the affected boreholes. */
  boreholes: string;
  reviewerName: string | null;
  /** Everything a widget needs except the swap flag, which the form itself holds. */
  ctx: Omit<WidgetContext, 'swapAxes'>;
  busy: DialogBusy;
  outcome: AnswerOutcome | null;
  onAnswer(values: Record<string, unknown>): void;
  onSkip(): void;
  onClose(): void;
  /** The evidence pane (the page cache); tests pass their own. */
  evidence: ReactNode;
}

const MISSING_FIELDS = 'Some answers are missing or can’t be read. Check the marked fields.';

/**
 * Keeps the keyboard inside the modal: Escape closes it (before the screen's own Escape handling),
 * and keys pressed outside it (focus lost to the page) never reach the screen behind it.
 */
function useModalKeys(root: RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key === 'Tab') return;
      const inside = e.target instanceof Node && !!root.current?.contains(e.target);
      if (!inside) e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [root]);
}

/**
 * The question dialog (pure; the store parts come in as props, so tests render it): evidence pages on
 * the left, the question and its form on the right, ANSWER and SKIP FOR NOW below. Inputs start from
 * the server's defaults only. ANSWER checks the form first (required fields, numbers, pages) and
 * shows each problem next to its field; the server's own field errors (422) show the same way, with
 * its message on top.
 */
export function ClarificationDialogView({
  clarification: c,
  documentName,
  boreholes,
  reviewerName,
  ctx,
  busy,
  outcome,
  onAnswer,
  onSkip,
  onClose,
  evidence,
}: ViewProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const downOnScrim = useRef(false);
  const ids = useId();
  const [inputs, setInputs] = useState<FormInputs>(() => initialInputs(c.fields));
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  /** Bumped by a refused ANSWER: the first marked field takes the focus. */
  const [errorNonce, setErrorNonce] = useState(0);

  useFocusTrap(dialog);
  useModalKeys(dialog, onClose);

  const errors = { ...localErrors, ...(outcome?.fieldErrors ?? {}) };
  const message = Object.keys(localErrors).length ? MISSING_FIELDS : (outcome?.message ?? null);
  const swapAxes = swapAxesInput(c.fields, inputs);
  const widgetCtx: WidgetContext = { ...ctx, swapAxes };
  const titleId = `${ids}-title`;
  const questionId = `${ids}-question`;
  const created = createdText(c.createdAt);

  useEffect(() => {
    if (!errorNonce) return;
    const first = dialog.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    first?.focus();
  }, [errorNonce]);

  const setInput = (name: string, input: FieldInput) => {
    setInputs((all) => ({ ...all, [name]: input }));
    setLocalErrors((all) => {
      if (!(name in all)) return all;
      const next = { ...all };
      delete next[name];
      return next;
    });
  };

  const answer = () => {
    if (busy) return;
    const { values, errors: found } = answerValues(c.fields, inputs, { pageCount: ctx.pageCount });
    setLocalErrors(found);
    if (Object.keys(found).length) {
      setErrorNonce((n) => n + 1);
      return;
    }
    onAnswer(values);
  };

  const skipped = c.status === 'skipped';
  const skipOff = busy ? 'Working…' : skipped ? 'Already skipped: the question stays in the inbox until it is answered' : undefined;

  return (
    <div
      className={styles.scrim}
      onMouseDown={(e) => {
        downOnScrim.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnScrim.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={questionId}
        tabIndex={-1}
        data-clarification-id={c.id}
        // Keys typed in the dialog never reach the screen's shortcuts behind it.
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className={styles.head}>
          <div className={styles.headText}>
            <h2 id={titleId} className={styles.title}>
              QUESTION · {kindLabel(c.kind).toUpperCase()}
            </h2>
            <div className={styles.subtitle}>
              {documentName ?? `Document ${c.documentId} (not loaded)`}
              {boreholes && ` · ${boreholes}`}
              {created && (
                <>
                  {' · asked '}
                  <time dateTime={c.createdAt}>{created}</time>
                </>
              )}
              {skipped && <span className={styles.skippedChip}>SKIPPED</span>}
            </div>
          </div>
          <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className={styles.body}>
          {evidence}
          <form
            className={styles.form}
            noValidate
            aria-label="Answer"
            onSubmit={(e) => {
              e.preventDefault();
              answer();
            }}
          >
            <p id={questionId} className={styles.question}>
              {c.question}
            </p>
            {message && (
              <div className={styles.message} role="alert">
                {message}
              </div>
            )}
            {c.fields.length === 0 && <p className={styles.help}>The backend sent no fields for this question.</p>}
            {c.fields.map((f, i) => (
              <FieldWidget
                key={f.name}
                field={f}
                input={inputs[f.name]}
                onChange={(input) => setInput(f.name, input)}
                error={errors[f.name] ?? null}
                idBase={`${ids}-f${i}`}
                ctx={widgetCtx}
              />
            ))}
            {c.fields.some((f) => f.required) && (
              <p className={styles.reqNote}>
                <span className={styles.req} aria-hidden="true">
                  *
                </span>{' '}
                required
              </p>
            )}
            {/* Enter in a text input answers. */}
            <button type="submit" hidden tabIndex={-1} aria-hidden="true" />
          </form>
        </div>

        <div className={styles.foot}>
          <button type="button" className={styles.answer} disabled={!!busy} title={busy ? 'Working…' : undefined} onClick={answer}>
            {busy === 'answer' ? 'ANSWERING…' : 'ANSWER'}
          </button>
          <button
            type="button"
            className={styles.skip}
            disabled={!!skipOff}
            title={skipOff}
            aria-description={skipOff}
            onClick={onSkip}
          >
            {busy === 'skip' ? 'SKIPPING…' : 'SKIP FOR NOW'}
          </button>
          <span className={styles.footNote}>
            {reviewerName ? `Stored with your name (${reviewerName}).` : 'No name is set: the answer is stored without one.'}
          </span>
        </div>
      </div>
    </div>
  );
}

const NO_CANDIDATES: CrsCandidatesState = { status: 'idle', candidates: [], error: null };

/** The document's CRS candidates when the question has a crs_picker field (read once per question). */
function useCrsCandidates(c: Clarification | undefined): CrsCandidatesState {
  const source = useAppStore((s) => s.source);
  const [state, setState] = useState<{ id: string; value: CrsCandidatesState } | null>(null);
  const needs = !!c && c.fields.some((f) => f.widget === 'crs_picker');
  const id = c?.id ?? null;
  const documentId = c?.documentId ?? null;

  useEffect(() => {
    if (!needs || !source || !id || !documentId) return;
    let live = true;
    setState({ id, value: { status: 'loading', candidates: [], error: null } });
    source.crsCandidates(documentId).then(
      (candidates) => live && setState({ id, value: { status: 'ready', candidates, error: null } }),
      (e: unknown) => live && setState({ id, value: { status: 'error', candidates: [], error: errorText(e) } }),
    );
    return () => {
      live = false;
    };
  }, [needs, source, id, documentId]);

  return state && state.id === id ? state.value : NO_CANDIDATES;
}

/** When the open question is not in the store's list: still loading, or no longer open. */
function NotOpenDialog({ loading, onClose }: { loading: boolean; onClose(): void }) {
  const dialog = useRef<HTMLDivElement>(null);
  useFocusTrap(dialog);
  useModalKeys(dialog, onClose);
  return (
    <div className={styles.scrim}>
      <div ref={dialog} className={`${styles.dialog} ${styles.dialogSmall}`} role="dialog" aria-modal="true" aria-label="Question" tabIndex={-1}>
        <div className={styles.head}>
          <h2 className={styles.title}>QUESTION</h2>
          <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <p className={styles.notOpen} role="status">
          {loading ? 'Loading the question…' : 'This question is not open any more: it was answered, or the link is wrong.'}
        </p>
      </div>
    </div>
  );
}

/**
 * The question dialog of the active clarification (FRONTEND.md F12), connected to the store: opened
 * from the inbox, a document card, Review or the chat (openClarification). ANSWER sends the form with
 * your name; on success it closes with a toast, else the server's field errors show next to their
 * fields. SKIP FOR NOW leaves the question in the inbox. Focus stays inside; Escape closes and the
 * focus goes back to the opener.
 */
export function ClarificationDialog() {
  const activeId = useAppStore((s) => s.activeClarificationId);
  const current = useAppStore((s) => s.clarifications.find((x) => x.id === s.activeClarificationId));
  const loading = useAppStore((s) => s.clarificationsState === 'loading' || s.clarificationsState === 'idle');
  const documents = useAppStore((s) => s.documents);
  const boreholes = useAppStore((s) => s.boreholes);
  const features = useAppStore((s) => s.features);
  const reviewerName = useAppStore((s) => s.reviewerName);
  const answerClarification = useAppStore((s) => s.answerClarification);
  const skipClarification = useAppStore((s) => s.skipClarification);
  const closeClarification = useAppStore((s) => s.closeClarification);
  const showToast = useAppStore((s) => s.showToast);
  const [busy, setBusy] = useState<DialogBusy>(null);
  const [outcome, setOutcome] = useState<{ id: string; value: AnswerOutcome } | null>(null);
  // While an answer or skip is in flight the store may drop the question before the dialog closes:
  // keep showing it until then, instead of "not open any more".
  const kept = useRef<Clarification | undefined>(undefined);
  if (current) kept.current = current;
  const c = current ?? (busy && kept.current?.id === activeId ? kept.current : undefined);
  const crs = useCrsCandidates(c);

  const known = useMemo(() => [...features, ...boreholes], [features, boreholes]);
  const labels = useMemo(() => Object.fromEntries(known.map((b) => [b.uid, b.id])), [known]);
  const reference = useMemo<ReferencePoint[]>(
    () =>
      c
        ? features
            .filter((f) => f.documentId === c.documentId && !c.boreholeUids.includes(f.uid))
            .map((f) => ({ label: f.id, lat: f.lat, lng: f.lng }))
        : [],
    [c, features],
  );

  if (!activeId) return null;
  if (!c) return <NotOpenDialog loading={loading} onClose={closeClarification} />;

  const doc = documents.find((d) => d.id === c.documentId);
  const pageCount = doc && doc.pages.length > 0 ? doc.pages.length : null;
  const id = c.id;

  /** Closes the dialog unless another question took its place meanwhile. */
  const done = (text: string) => {
    if (useAppStore.getState().activeClarificationId === id) closeClarification();
    showToast(text);
  };

  const onAnswer = async (values: Record<string, unknown>) => {
    setBusy('answer');
    setOutcome(null);
    try {
      const r = await answerClarification(id, values);
      if (r.ok) done(reviewerName ? `Answer stored with your name (${reviewerName}).` : 'Answer stored.');
      else setOutcome({ id, value: { message: r.message, fieldErrors: r.fieldErrors } });
    } catch (e) {
      setOutcome({ id, value: { message: errorText(e), fieldErrors: {} } });
    } finally {
      setBusy(null);
    }
  };

  const onSkip = async () => {
    setBusy('skip');
    setOutcome(null);
    try {
      await skipClarification(id);
      done('Skipped for now: the question stays in the inbox.');
    } catch (e) {
      setOutcome({ id, value: { message: errorText(e), fieldErrors: {} } });
    } finally {
      setBusy(null);
    }
  };

  return (
    <ClarificationDialogView
      key={id}
      clarification={c}
      documentName={doc?.name ?? null}
      boreholes={boreholeText(c.boreholeUids, known)}
      reviewerName={reviewerName}
      ctx={{ pageCount, crs, reference, labels }}
      busy={busy}
      outcome={outcome?.id === id ? outcome.value : null}
      onAnswer={(values) => void onAnswer(values)}
      onSkip={() => void onSkip()}
      onClose={closeClarification}
      evidence={<EvidencePane evidence={c.evidence} documentId={c.documentId} />}
    />
  );
}
