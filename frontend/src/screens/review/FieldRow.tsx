import { memo, useEffect, useRef, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { CertaintyMark } from '../../components/CertaintyMark';
import { lintText } from '../../domain/format';
import { refusalTitle } from '../../domain/spt';
import type { ExtractedValue, FieldState } from '../../domain/types';
import { useT } from '../../i18n';
import { useAppStore, type EditingState } from '../../store/appStore';
import { NO_SOURCE_REFERENCE } from '../../store/reviewSlice';
import { fill } from './fill';
import styles from './FieldRow.module.css';
import { methodText, pageText, rawText, readingText, sptTitle, valueMark, type Note } from './reviewView';

interface Props {
  uid: string;
  value: ExtractedValue;
  focused: boolean;
  /** The inline edit of this row, or null. */
  editing: EditingState | null;
  /** Normalised text (unit, "(confirmed)"), see reviewView.normalisedText. */
  normText: string;
  note: Note | null;
  /** True for a CRS row: shows CHOOSE CRS… in the more-actions bar. */
  canChooseCrs: boolean;
  /** The value's source is in another document than the borehole's (e.g. a lab spreadsheet). */
  elsewhere?: boolean;
  /** An unresolved question about this value: its Question button opens the question dialog. */
  questionId?: string | null;
}

const stop = (e: MouseEvent) => e.stopPropagation();

const NOTE_CLASS: Record<Note['tone'], string> = { faint: styles.noteFaint, ok: styles.noteOk, warn: styles.noteWarn };

/**
 * One value in the Review list (frontend_din row): label + page (or spreadsheet cell), raw →
 * normalised (or the 3-line lithology, or the state), readings side by side when readers disagreed,
 * AI value struck through after an edit, note, lint, flag, the Question button when an unresolved
 * question is about the value, inline edit / flag input, more actions while focused, the certainty
 * dot (✓ sure · ? unsure · ! flagged · – not in source; how it was read is in its tooltip and, while
 * focused, next to the more actions) and ✓ ✎ ⚑. A click anywhere on the row focuses it, which shows
 * its source box on the scan. A value without a provenance entry can't be reviewed: its actions are
 * disabled with the reason. A read-only value (`readOnlyReason`) can't be edited, but can be
 * approved, flagged and set to a state.
 */
function FieldRowImpl({ uid, value: v, focused, editing, normText, note, canChooseCrs, elsewhere = false, questionId = null }: Props) {
  const t = useT();
  const focusValue = useAppStore((s) => s.focusValue);
  const toggleApprove = useAppStore((s) => s.toggleApprove);
  const toggleFlag = useAppStore((s) => s.toggleFlag);
  const startEdit = useAppStore((s) => s.startEdit);
  const setEditText = useAppStore((s) => s.setEditText);
  const saveEdit = useAppStore((s) => s.saveEdit);
  const cancelEdit = useAppStore((s) => s.cancelEdit);
  const setState = useAppStore((s) => s.setState);
  const openSource = useAppStore((s) => s.openSource);
  const openCrsDialog = useAppStore((s) => s.openCrsDialog);
  const openClarification = useAppStore((s) => s.openClarification);

  const rowRef = useRef<HTMLDivElement>(null);
  const editBtn = useRef<HTMLButtonElement>(null);
  const flagBtn = useRef<HTMLButtonElement>(null);
  /** Mode of the inline edit that is open, kept to return focus to its button once it closes. */
  const openMode = useRef<EditingState['mode'] | null>(null);

  // After SAVE / CANCEL (Enter / Escape) focus goes back to the ✎ or ⚑ that opened the input,
  // unless the user has moved on: another row focused, or focus already elsewhere.
  useEffect(() => {
    if (editing) {
      openMode.current = editing.mode;
      return;
    }
    const mode = openMode.current;
    openMode.current = null;
    if (!mode || !focused) return;
    const active = document.activeElement;
    if (active && active !== document.body && !rowRef.current?.contains(active)) return;
    (mode === 'flag' ? flagBtn : editBtn).current?.focus();
  }, [editing, focused]);

  // Keyboard focus inside a row (Tab to ✓ ✎ ⚑) makes it the focused row, so A / E / F act on it.
  // Mouse focus doesn't: refocusing on mousedown would move the rows before the click lands.
  const onRowFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (focused || useAppStore.getState().editing) return;
    if (!(e.target instanceof Element) || !e.target.matches(':focus-visible')) return;
    focusValue(v.key);
  };

  const isState = v.state !== 'ok';
  const isLith = v.kind === 'lithology' && !isState;
  const approved = v.status === 'approved';
  const flagged = v.status === 'flagged';
  const valueIsError = !!v.lint && v.kind === 'spt';
  const showAi = v.method === 'Edited' && v.aiValue !== v.value;
  const locked = !v.hasProvenance;
  const lockedTitle = locked ? t(NO_SOURCE_REFERENCE) : undefined;
  // Why ✎ is off for a value with provenance (e.g. a CRS set only through the CRS dialog).
  const editBlocked = !locked && v.readOnlyReason ? v.readOnlyReason : undefined;
  const mark = valueMark(v, t);
  const label = t(v.label);

  const onEditKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveEdit();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      cancelEdit();
    }
  };

  const stateButton = (state: Exclude<FieldState, 'ok'>, text: string) => (
    <button
      type="button"
      className={`${styles.more} ${v.state === state ? styles.morePressed : ''}`}
      aria-pressed={v.state === state}
      disabled={locked}
      title={lockedTitle}
      onClick={() => setState(v.key, state)}
    >
      {t(text)}
    </button>
  );

  return (
    <div
      ref={rowRef}
      data-key={v.key}
      className={`${styles.row} ${focused ? styles.focused : ''}`}
      onClick={() => focusValue(v.key)}
      onFocus={onRowFocus}
      aria-current={focused ? 'true' : undefined}
    >
      <div className={styles.labelCell}>
        <span className={styles.label}>{label}</span>
        <span className={`${styles.page} ${locked ? styles.pageMissing : ''}`}>{pageText(v, elsewhere, t)}</span>
      </div>

      <div className={styles.valueCell}>
        {!isLith && !isState && (
          <div className={styles.pair}>
            <span className={styles.raw}>{rawText(v)}</span>
            {/* The arrow stays with the normalised value: when the line is too narrow, both wrap together. */}
            <span className={styles.to}>
              <span className={styles.arrow}>→</span>
              {v.refusal && v.spt && (
                <span className={styles.refusal} title={refusalTitle(v.spt)}>
                  R
                </span>
              )}
              <span className={`${styles.norm} ${valueIsError ? styles.normError : ''}`} title={sptTitle(v)}>
                {normText}
              </span>
            </span>
          </div>
        )}
        {isLith && (
          <div className={styles.lith}>
            <span className={styles.lithKey}>{t('PRINTED')}</span>
            <span className={styles.lithRaw}>{v.raw || '—'}</span>
            <span className={styles.lithKey}>{t('ENGLISH')}</span>
            <span className={styles.lithEn}>{v.value || '—'}</span>
            <span className={styles.lithKey}>DIN 4023</span>
            <span className={styles.lithDin}>{v.din || '—'}</span>
          </div>
        )}
        {isState && <span className={styles.state}>{t(v.state)}</span>}
        {v.readings && v.readings.length > 0 && (
          <div className={styles.readings} aria-label={fill(t('Readings of {label}'), { label })}>
            <span className={styles.lithKey}>{t('READINGS')}</span>
            {v.readings.map((r, i) => (
              <span key={i} className={styles.reading}>
                {readingText(r)}
              </span>
            ))}
          </div>
        )}
        {showAi && (
          <span className={styles.ai}>
            <s>{v.aiValue || '—'}</s> {t('(AI value)')}
          </span>
        )}
        {note && <span className={NOTE_CLASS[note.tone]}>{note.text}</span>}
        {v.lint && (
          <span className={v.lint.severity === 'error' ? styles.lintError : styles.lintWarn}>
            {v.lint.severity === 'error' ? '✕ ' : '⚠ '}
            {lintText(v.lint)}
          </span>
        )}
        {v.flag && <span className={styles.flagText}>⚑ {fill(t('Flagged: {reason}'), { reason: v.flag })}</span>}
        {questionId && (
          <button
            type="button"
            className={styles.question}
            aria-label={fill(t('Question about {label}'), { label })}
            title={t('The backend asks a question about this value: open it')}
            onClick={(e) => {
              e.stopPropagation();
              openClarification(questionId);
            }}
          >
            ? {t('Question')}
          </button>
        )}

        {editing && (
          <div className={styles.edit} onClick={stop}>
            <input
              className={styles.input}
              autoFocus
              value={editing.text}
              placeholder={editing.mode === 'flag' ? t('Reason, e.g. boundary looks off') : t('Corrected value')}
              aria-label={fill(t(editing.mode === 'flag' ? 'Flag reason for {label}' : 'Corrected value for {label}'), { label })}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={onEditKey}
            />
            <button type="button" className={styles.save} onClick={saveEdit}>
              {t('SAVE')}
            </button>
            <button type="button" className={styles.cancel} onClick={cancelEdit}>
              {t('CANCEL')}
            </button>
          </div>
        )}

        {focused && !editing && (
          <div className={styles.moreBar} onClick={stop}>
            {canChooseCrs && (
              <button type="button" className={styles.crs} onClick={() => void openCrsDialog()}>
                {t('CHOOSE CRS…')}
              </button>
            )}
            {stateButton('not in source', 'Not in source')}
            {stateButton('illegible', 'Illegible')}
            <button
              type="button"
              className={styles.more}
              disabled={locked}
              title={lockedTitle}
              onClick={() => openSource(uid, v.key)}
            >
              {t('Larger source view')}
            </button>
            <span className={styles.methodNote}>{methodText(v, t)}</span>
          </div>
        )}
      </div>

      <div className={styles.mark}>
        <CertaintyMark certainty={mark} />
      </div>

      <div className={styles.actions} onClick={stop}>
        <button
          type="button"
          className={`${styles.act} ${styles.actApprove} ${approved ? styles.actApproved : ''}`}
          title={lockedTitle ?? (approved ? t('Approved: click to undo (A)') : t('Approve (A)'))}
          aria-label={fill(t('Approve {label}'), { label })}
          aria-keyshortcuts="A"
          aria-pressed={approved}
          disabled={locked}
          onClick={() => toggleApprove(v.key)}
        >
          ✓
        </button>
        <button
          ref={editBtn}
          type="button"
          className={styles.act}
          title={lockedTitle ?? editBlocked ?? t('Edit (E)')}
          aria-label={fill(t('Edit {label}'), { label })}
          aria-keyshortcuts="E"
          aria-description={editBlocked}
          disabled={locked || !!editBlocked}
          onClick={() => startEdit(v.key, 'edit')}
        >
          ✎
        </button>
        <button
          ref={flagBtn}
          type="button"
          className={`${styles.act} ${flagged ? styles.actFlagged : ''}`}
          title={lockedTitle ?? (flagged ? t('Flagged: click to remove the flag (F)') : t('Flag (F)'))}
          aria-label={fill(t('Flag {label}'), { label })}
          aria-keyshortcuts="F"
          aria-pressed={flagged}
          disabled={locked}
          onClick={() => toggleFlag(v.key)}
        >
          ⚑
        </button>
      </div>
    </div>
  );
}

export const FieldRow = memo(FieldRowImpl);
