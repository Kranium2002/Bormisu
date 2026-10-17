import { memo, useEffect, useRef, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { MethodBadge } from '../../components/MethodBadge';
import { refusalTitle } from '../../domain/spt';
import type { ExtractedValue, FieldState } from '../../domain/types';
import { useAppStore, type EditingState } from '../../store/appStore';
import styles from './FieldRow.module.css';
import { pageText, rawText, sptTitle, type Note } from './reviewView';

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
}

const stop = (e: MouseEvent) => e.stopPropagation();

const NOTE_CLASS: Record<Note['tone'], string> = { faint: styles.noteFaint, ok: styles.noteOk, warn: styles.noteWarn };

/**
 * One value in the Review list (prototype field row): label + page, raw → normalised (or the
 * 3-line lithology, or the state), AI value struck through after an edit, note, lint, flag,
 * inline edit / flag input, more actions while focused, method badge and ✓ ✎ ⚑.
 */
function FieldRowImpl({ uid, value: v, focused, editing, normText, note, canChooseCrs }: Props) {
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

  const onEditKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveEdit();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      cancelEdit();
    }
  };

  const stateButton = (state: Exclude<FieldState, 'ok'>, label: string) => (
    <button
      type="button"
      className={`${styles.more} ${v.state === state ? styles.morePressed : ''}`}
      aria-pressed={v.state === state}
      onClick={() => setState(v.key, state)}
    >
      {label}
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
        <span className={styles.label}>{v.label}</span>
        <span className={styles.page}>{pageText(v)}</span>
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
            <span className={styles.lithKey}>PRINTED</span>
            <span className={styles.lithRaw}>{v.raw || '—'}</span>
            <span className={styles.lithKey}>ENGLISH</span>
            <span className={styles.lithEn}>{v.value || '—'}</span>
            <span className={styles.lithKey}>DIN 4023</span>
            <span className={styles.lithDin}>{v.din || '—'}</span>
          </div>
        )}
        {isState && <span className={styles.state}>{v.state}</span>}
        {showAi && (
          <span className={styles.ai}>
            <s>{v.aiValue || '—'}</s> (AI value)
          </span>
        )}
        {note && <span className={NOTE_CLASS[note.tone]}>{note.text}</span>}
        {v.lint && (
          <span className={v.lint.severity === 'error' ? styles.lintError : styles.lintWarn}>
            {v.lint.severity === 'error' ? '✕ ' : '⚠ '}
            {v.lint.message}
          </span>
        )}
        {v.flag && <span className={styles.flagText}>⚑ Flagged: {v.flag}</span>}

        {editing && (
          <div className={styles.edit} onClick={stop}>
            <input
              className={styles.input}
              autoFocus
              value={editing.text}
              placeholder={editing.mode === 'flag' ? 'Reason, e.g. boundary looks off' : 'Corrected value'}
              aria-label={editing.mode === 'flag' ? `Flag reason for ${v.label}` : `Corrected value for ${v.label}`}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={onEditKey}
            />
            <button type="button" className={styles.save} onClick={saveEdit}>
              SAVE
            </button>
            <button type="button" className={styles.cancel} onClick={cancelEdit}>
              CANCEL
            </button>
          </div>
        )}

        {focused && !editing && (
          <div className={styles.moreBar} onClick={stop}>
            {canChooseCrs && (
              <button type="button" className={styles.crs} onClick={() => void openCrsDialog()}>
                CHOOSE CRS…
              </button>
            )}
            {stateButton('not in source', 'Not in source')}
            {stateButton('illegible', 'Illegible')}
            <button type="button" className={styles.more} onClick={() => openSource(uid, v.key)}>
              Larger source view
            </button>
          </div>
        )}
      </div>

      <div>
        <MethodBadge method={v.method} confidence={v.confidence} formula={v.formula} />
      </div>

      <div className={styles.actions} onClick={stop}>
        <button
          type="button"
          className={`${styles.act} ${styles.actApprove} ${approved ? styles.actApproved : ''}`}
          title={approved ? 'Approved: click to undo (A)' : 'Approve (A)'}
          aria-label={`Approve ${v.label}`}
          aria-keyshortcuts="A"
          aria-pressed={approved}
          onClick={() => toggleApprove(v.key)}
        >
          ✓
        </button>
        <button
          ref={editBtn}
          type="button"
          className={styles.act}
          title="Edit (E)"
          aria-label={`Edit ${v.label}`}
          aria-keyshortcuts="E"
          onClick={() => startEdit(v.key, 'edit')}
        >
          ✎
        </button>
        <button
          ref={flagBtn}
          type="button"
          className={`${styles.act} ${flagged ? styles.actFlagged : ''}`}
          title={flagged ? 'Flagged: click to remove the flag (F)' : 'Flag (F)'}
          aria-label={`Flag ${v.label}`}
          aria-keyshortcuts="F"
          aria-pressed={flagged}
          onClick={() => toggleFlag(v.key)}
        >
          ⚑
        </button>
      </div>
    </div>
  );
}

export const FieldRow = memo(FieldRowImpl);
