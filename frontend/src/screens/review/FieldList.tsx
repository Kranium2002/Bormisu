import { useEffect, useMemo, useRef } from 'react';
import { fromOtherDocument } from '../../domain/review';
import type { Borehole } from '../../domain/types';
import { useAppStore } from '../../store/appStore';
import { FieldRow } from './FieldRow';
import styles from './ReviewScreen.module.css';
import { crsActionKey, fieldNote, normalisedText, questionKeys, reviewRows } from './reviewView';

/** Space kept above a row scrolled into view (prototype: offsetTop - 60), clears the sticky column header. */
const ROW_OFFSET = 60;

/** Scrolls a row into view unless it is already fully visible below the sticky header. */
function reveal(list: HTMLElement, key: string | null | undefined, behavior: ScrollBehavior) {
  if (!key) return;
  const row = list.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
  if (!row) return;
  const head = (list.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0;
  const top = row.offsetTop;
  const bottom = top + row.offsetHeight;
  if (top >= list.scrollTop + head && bottom <= list.scrollTop + list.clientHeight) return;
  list.scrollTo({ top: Math.max(0, top - ROW_OFFSET), behavior });
}

/** Right half of the Review screen: sticky column header and the grouped field rows. */
export function FieldList({ b }: { b: Borehole }) {
  const focusKey = useAppStore((s) => s.focusKey);
  const editing = useAppStore((s) => s.editing);
  const listScroll = useAppStore((s) => s.listScroll);
  const clarifications = useAppStore((s) => s.clarifications);
  const ref = useRef<HTMLDivElement>(null);
  const shownUid = useRef<string | null>(null);

  const rows = useMemo(
    () =>
      reviewRows(b).map((r) =>
        r.kind === 'head'
          ? r
          : { ...r, normText: normalisedText(b, r.value), note: fieldNote(b, r.value), elsewhere: fromOtherDocument(b, r.value) },
      ),
    [b],
  );
  // CHOOSE CRS… sits on the CRS value, or on X / Y when the log printed no system.
  const crsKey = useMemo(() => crsActionKey(b), [b]);
  // A value an unresolved question is about gets a Question button.
  const questions = useMemo(() => questionKeys(b, clarifications), [b, clarifications]);

  // A new borehole starts at the top with its focused row in view; a list-scroll signal reveals its row.
  useEffect(() => {
    const list = ref.current;
    if (!list) return;
    const switched = shownUid.current !== b.uid;
    if (switched && shownUid.current !== null) list.scrollTop = 0;
    shownUid.current = b.uid;
    const key = switched ? useAppStore.getState().focusKey : listScroll?.key;
    reveal(list, key, switched ? 'auto' : 'smooth');
  }, [b.uid, listScroll]);

  return (
    <div ref={ref} className={styles.list} aria-label="Extracted values">
      <div className={styles.colHead}>
        <div>FIELD</div>
        <div>AS PRINTED → NORMALISED</div>
        <div>METHOD</div>
        <div className={styles.colRight} title="Keys: J / K move · A approve · E edit · F flag · Esc cancel">
          ACTIONS
        </div>
      </div>
      {rows.length === 0 && <div className={styles.emptyList}>No values were extracted for this borehole.</div>}
      {rows.map((r) =>
        r.kind === 'head' ? (
          <div key={r.id} className={styles.groupHead}>
            {r.title}
          </div>
        ) : (
          <FieldRow
            key={r.value.key}
            uid={b.uid}
            value={r.value}
            focused={r.value.key === focusKey}
            editing={editing?.key === r.value.key ? editing : null}
            normText={r.normText}
            note={r.note}
            canChooseCrs={r.value.key === crsKey}
            elsewhere={r.elsewhere}
            questionId={questions[r.value.key] ?? null}
          />
        ),
      )}
    </div>
  );
}
