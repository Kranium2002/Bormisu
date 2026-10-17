import { memo, type KeyboardEvent, type MouseEvent } from 'react';
import { MethodBadge } from '../../components/MethodBadge';
import { lintText } from '../../domain/format';
import { refusalTitle } from '../../domain/spt';
import type { ExtractedValue, FieldState } from '../../domain/types';
import { useAppStore, type EditingState } from '../../store/appStore';
import { NO_SOURCE_REFERENCE } from '../../store/reviewSlice';
import styles from './FieldRow.module.css';
import { pageText, rawText, readingText, sptTitle, type Note } from './reviewView';

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
}

const stop = (e: MouseEvent) => e.stopPropagation();

const NOTE_CLASS: Record<Note['tone'], string> = { faint: styles.noteFaint, ok: styles.noteOk, warn: styles.noteWarn };

/**
 * One value in the Review list (prototype field row): label + page (or spreadsheet cell), raw →
 * normalised (or the 3-line lithology, or the state), readings side by side when readers disagreed,
 * AI value struck through after an edit, note, lint, flag, inline edit / flag input, more actions
 * while focused, method badge and ✓ ✎ ⚑. A value without a provenance entry can't be reviewed:
 * its actions are disabled with the reason. A read-only value (`readOnlyReason`) can't be edited, but
 * can be approved, flagged and set to a state.
 */
function FieldRowImpl({ uid, value: v, focused, editing, normText, note, canChooseCrs, elsewhere = false }: Props) {
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

  const isState = v.state !== 'ok';
  const isLith = v.kind === 'lithology' && !isState;
  const approved = v.status === 'approved';
  const flagged = v.status === 'flagged';
  const valueIsError = !!v.lint && v.kind === 'spt';
  const showAi = v.method === 'Edited' && v.aiValue !== v.value;
  const locked = !v.hasProvenance;
  const lockedTitle = locked ? NO_SOURCE_REFERENCE : undefined;
  // Why ✎ is off for a value with provenance (e.g. a CRS set only through the CRS dialog).
  const editBlocked = !locked && v.readOnlyReason ? v.readOnlyReason : undefined;

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
      disabled={locked}
      title={lockedTitle}
      onClick={() => setState(v.key, state)}
    >
      {label}
    </button>
  );

  return (
    <div
      data-key={v.key}
      className={`${styles.row} ${focused ? styles.focused : ''}`}
      onClick={() => focusValue(v.key)}
      aria-current={focused ? 'true' : undefined}
    >
      <div className={styles.labelCell}>
        <span className={styles.label}>{v.label}</span>
        <span className={`${styles.page} ${locked ? styles.pageMissing : ''}`}>{pageText(v, elsewhere)}</span>
      </div>

      <div className={styles.valueCell}>
        {!isLith && !isState && (
          <div className={styles.pair}>
            <span className={styles.raw}>{rawText(v)}</span>
            <span className={styles.arrow}>→</span>
            {v.refusal && v.spt && (
              <span className={styles.refusal} title={refusalTitle(v.spt)}>
                R
              </span>
            )}
            <span className={`${styles.norm} ${valueIsError ? styles.normError : ''}`} title={sptTitle(v)}>
              {normText}
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
        {v.readings && v.readings.length > 0 && (
          <div className={styles.readings} aria-label={`Readings of ${v.label}`}>
            <span className={styles.lithKey}>READINGS</span>
            {v.readings.map((r, i) => (
              <span key={i} className={styles.reading}>
                {readingText(r)}
              </span>
            ))}
          </div>
        )}
        {showAi && (
          <span className={styles.ai}>
            <s>{v.aiValue || '—'}</s> (AI value)
          </span>
        )}
        {note && <span className={NOTE_CLASS[note.tone]}>{note.text}</span>}
        {v.lint && (
          <span className={v.lint.severity === 'error' ? styles.lintError : styles.lintWarn}>
            {v.lint.severity === 'error' ? '✕ ' : '⚠ '}
            {lintText(v.lint)}
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
              Cancel
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
            <button
              type="button"
              className={styles.more}
              disabled={locked}
              title={lockedTitle}
              onClick={() => openSource(uid, v.key)}
            >
              Larger source view
            </button>
          </div>
        )}
      </div>

      <div>
        {v.method ? (
          <MethodBadge method={v.method} confidence={v.confidence} formula={v.formula} />
        ) : (
          <span className={styles.noMethod} title="The backend sent no method for this value">
            —
          </span>
        )}
      </div>

      <div className={styles.actions} onClick={stop}>
        <button
          type="button"
          className={`${styles.act} ${styles.actApprove} ${approved ? styles.actApproved : ''}`}
          title={lockedTitle ?? (approved ? 'Approved: click to undo' : 'Approve')}
          aria-label={`Approve ${v.label}`}
          aria-pressed={approved}
          disabled={locked}
          onClick={() => toggleApprove(v.key)}
        >
          ✓
        </button>
        <button
          type="button"
          className={styles.act}
          title={lockedTitle ?? editBlocked ?? 'Edit'}
          aria-label={`Edit ${v.label}`}
          aria-description={editBlocked}
          disabled={locked || !!editBlocked}
          onClick={() => startEdit(v.key, 'edit')}
        >
          ✎
        </button>
        <button
          type="button"
          className={`${styles.act} ${flagged ? styles.actFlagged : ''}`}
          title={lockedTitle ?? (flagged ? 'Flagged: click to remove the flag' : 'Flag')}
          aria-label={`Flag ${v.label}`}
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
