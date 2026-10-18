/**
 * PLANNED LINE (contract 1.3.0): the path of a future tunnel, pipeline or drilling line, uploaded as a
 * GeoJSON, KML, GPX or CSV file (dropped here or on the map, or chosen) or drawn on the map, and every
 * borehole within the search distance of it.
 *
 * - A CSV with x/y columns needs its EPSG code: the field shows for a CSV, and when the server answers
 *   epsg_required the file is kept and the field gets the focus, so UPLOAD AGAIN sends it with the code.
 * - The line, its band and the hits (as the active result set: pins highlighted, LIST, chat) are on
 *   the map; the table lists the hits by chainage. A row shows its borehole on the map (its popup
 *   opens), DETAIL › opens it. The distance (Enter or leaving the field) and "Include unreviewed"
 *   (on by default, as the map shows unreviewed pins; off: approved boreholes only) ask again.
 * - Notes say how many unreviewed boreholes inside the band are hidden, and how many boreholes are not
 *   on the map and so cannot be checked against the line.
 * - EXPORT REPORT opens the printable report of the hits (by chainage); CLEAR takes the line off the
 *   map; DELETE removes it; earlier lines can be shown again.
 *
 * Like the FILTERS panel it stays mounted while closed (hidden); Escape and CLOSE close it.
 */
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { StatusChip } from '../../../components/StatusChip';
import { Toggle } from '../../../components/Toggle';
import type { AlignmentHit } from '../../../domain/types';
import { useT } from '../../../i18n';
import { lineReportPath, EXPORT_REPORT } from '../../../report/ReportButton';
import { useAppStore } from '../../../store/appStore';
import {
  ALIGNMENT_ACCEPT,
  chainageText,
  depthText,
  hitRows,
  isAlignmentFile,
  isCsv,
  lengthText,
  offsetText,
  parseBuffer,
  parseEpsg,
  SIDE_LABEL,
} from './alignmentModel';
import styles from './PlannedLinePanel.module.css';

export const ONLY_LINE_FILES = 'Only GeoJSON, KML, GPX or CSV files can be a planned line.';
export const DRAW_HINT = 'Click the points of the line; double-click or press Enter to finish. Esc cancels.';

interface Props {
  open: boolean;
  onClose(): void;
}

/** The first line file of a drop or a file input, or null. */
const lineFileOf = (files: FileList | null | undefined): File | null => (files && files.length ? files[0] : null);

export function PlannedLinePanel({ open, onClose }: Props) {
  const t = useT();
  const alignment = useAppStore((s) => s.alignment);
  const result = useAppStore((s) => s.alignmentResult);
  const alignments = useAppStore((s) => s.alignments);
  const bufferM = useAppStore((s) => s.alignmentBufferM);
  const includeUnreviewed = useAppStore((s) => s.alignmentIncludeUnreviewed);
  const busy = useAppStore((s) => s.alignmentBusy);
  const error = useAppStore((s) => s.alignmentError);
  const drawing = useAppStore((s) => s.alignmentDrawing);
  const selectedUid = useAppStore((s) => s.selectedUid);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const epsgRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  /** The file of the last upload that needs an EPSG code (kept for UPLOAD AGAIN). */
  const [pending, setPending] = useState<File | null>(null);
  const [epsgText, setEpsgText] = useState('');
  const [bufferText, setBufferText] = useState(String(bufferM));
  const [localError, setLocalError] = useState<string | null>(null);

  // The distance field follows the store (an earlier line brings its own distance).
  useEffect(() => setBufferText(String(bufferM)), [bufferM]);

  // Opened: the earlier lines are listed and the focus goes into the panel.
  useEffect(() => {
    if (!open) return;
    void useAppStore.getState().listAlignments();
    ref.current?.querySelector<HTMLElement>('button')?.focus();
  }, [open]);

  // epsg_required: the field gets the focus, the file waits for UPLOAD AGAIN.
  useEffect(() => {
    if (error?.code === 'epsg_required') epsgRef.current?.focus();
  }, [error]);

  const epsg = parseEpsg(epsgText);
  const needsEpsg = error?.code === 'epsg_required' && pending !== null;
  const showEpsg = needsEpsg || (pending !== null && isCsv(pending.name)) || epsgText.trim() !== '';

  async function send(file: File): Promise<void> {
    setLocalError(null);
    if (!isAlignmentFile(file.name)) {
      setLocalError(t(ONLY_LINE_FILES));
      return;
    }
    if (epsg === 'invalid') {
      setLocalError(t('The EPSG code is a number such as 25832.'));
      epsgRef.current?.focus();
      return;
    }
    setPending(file);
    const ok = await useAppStore.getState().uploadAlignment(file, { epsg });
    if (ok) setPending(null);
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const file = lineFileOf(e.dataTransfer?.files);
    if (file) void send(file);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !open) return;
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
    onClose();
  };

  const applyBuffer = () => {
    const m = parseBuffer(bufferText);
    if (m == null) {
      setBufferText(String(bufferM));
      return;
    }
    void useAppStore.getState().setAlignmentBuffer(m);
  };

  const bufferInvalid = parseBuffer(bufferText) == null;
  const hits = result ? hitRows(result.hits) : [];
  const earlier = (alignments ?? []).filter((a) => a.id !== alignment?.id);

  return (
    <div
      ref={ref}
      id="planned-line-panel"
      className={styles.panel}
      role="region"
      aria-label="Planned line"
      hidden={!open}
      onKeyDown={onKeyDown}
    >
      <div className={styles.head}>
        <span className={styles.headTitle}>{t('PLANNED LINE')}</span>
        <button type="button" className={styles.close} onClick={onClose}>
          {t('CLOSE')}
        </button>
      </div>

      <div className={styles.section}>
        <div
          className={`${styles.drop} ${over ? styles.dropOver : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          data-testid="planned-line-drop"
        >
          <span>{t('Drop the line of a planned tunnel, pipeline or drilling line here: GeoJSON, KML, GPX or CSV.')}</span>
          <div className={styles.dropActions}>
            <button type="button" className={styles.choose} disabled={busy === 'upload'} onClick={() => inputRef.current?.click()}>
              {t('CHOOSE FILE')}
            </button>
            <button
              type="button"
              className={styles.draw}
              aria-pressed={drawing}
              disabled={busy === 'upload'}
              onClick={() => useAppStore.getState().setAlignmentDrawing(!drawing)}
            >
              {drawing ? t('CANCEL DRAWING') : t('DRAW LINE')}
            </button>
          </div>
          <input
            ref={inputRef}
            className={styles.fileInput}
            type="file"
            accept={ALIGNMENT_ACCEPT}
            aria-label={t('Planned line file')}
            data-testid="planned-line-input"
            onChange={(e) => {
              const file = lineFileOf(e.target.files);
              e.target.value = '';
              if (file) void send(file);
            }}
          />
        </div>
        {drawing && (
          <p className={styles.hint} role="status">
            {t(DRAW_HINT)}
          </p>
        )}
        {showEpsg && (
          <div className={styles.row}>
            <label className={styles.field}>
              <span className={styles.label}>{t('EPSG code of the CSV x/y columns')}</span>
              <input
                ref={epsgRef}
                className={`${styles.input} ${styles.narrow}`}
                inputMode="numeric"
                placeholder="25832"
                value={epsgText}
                aria-invalid={needsEpsg && epsg == null ? true : epsg === 'invalid' ? true : undefined}
                onChange={(e) => setEpsgText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && pending) void send(pending);
                }}
              />
            </label>
            {pending && (
              <button type="button" className={styles.secondary} disabled={busy === 'upload'} onClick={() => void send(pending)}>
                {t('UPLOAD AGAIN')}
              </button>
            )}
          </div>
        )}
        {showEpsg && <p className={styles.hint}>{t('Positions are never guessed: x/y columns need the code of their coordinate system, e.g. 25832 for ETRS89 / UTM zone 32N.')}</p>}
        {busy === 'upload' && (
          <p className={styles.status} role="status">
            {t('Uploading the line…')}
          </p>
        )}
        {(localError || (error && !alignment)) && (
          <p className={styles.error} role="alert">
            {localError ?? error?.text}
          </p>
        )}
      </div>

      {alignment && (
        <div className={styles.section} aria-label="Shown line">
          <div>
            <p className={styles.lineName}>{alignment.name}</p>
            <p className={styles.lineMeta}>
              {lengthText(result?.lengthM ?? alignment.lengthM)} · {alignment.fileName} · {alignment.sourceCrs}
              {alignment.partCount > 1 ? ` · ${alignment.partCount} ${t('parts')}` : ''}
            </p>
          </div>
          <div className={styles.row}>
            <label className={styles.field}>
              <span className={styles.label}>{t('Distance either side (m)')}</span>
              <input
                className={`${styles.input} ${styles.narrow}`}
                inputMode="decimal"
                value={bufferText}
                aria-invalid={bufferInvalid ? true : undefined}
                data-testid="planned-line-buffer"
                onChange={(e) => setBufferText(e.target.value)}
                onBlur={applyBuffer}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applyBuffer();
                }}
              />
            </label>
            <span className={styles.toggleField}>
              <Toggle
                id="planned-line-include-unreviewed"
                on={includeUnreviewed}
                onToggle={() => void useAppStore.getState().setAlignmentIncludeUnreviewed(!includeUnreviewed)}
              />
              <label htmlFor="planned-line-include-unreviewed">{t('Include unreviewed')}</label>
            </span>
          </div>
          {bufferInvalid && <p className={styles.hint}>{t('A distance above 0 and at most 1000 m.')}</p>}
          {busy === 'query' && (
            <p className={styles.status} role="status">
              {t('Finding boreholes along the line…')}
            </p>
          )}
          {error && (
            <p className={styles.error} role="alert">
              {error.text}
            </p>
          )}
          {result && <HitTable hits={hits} bufferM={result.bufferM} selectedUid={selectedUid} />}
          {result && <LineNotes excludedUnreviewed={result.excludedUnreviewed} notOnMap={result.notOnMap} />}
          <div className={styles.actions}>
            {result && (
              <Link className={styles.secondary} to={lineReportPath(alignment, result)} data-testid="export-report">
                {t(EXPORT_REPORT)}
              </Link>
            )}
            <button type="button" className={styles.secondary} onClick={() => useAppStore.getState().clearAlignment()}>
              {t('CLEAR')}
            </button>
            <button
              type="button"
              className={styles.quiet}
              disabled={busy === 'delete'}
              onClick={() => void useAppStore.getState().deleteAlignment(alignment.id)}
            >
              {t('DELETE LINE')}
            </button>
          </div>
        </div>
      )}

      {earlier.length > 0 && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>{t('EARLIER LINES')}</h3>
          <ul className={styles.list} aria-label="Earlier lines">
            {earlier.map((a) => (
              <li key={a.id} className={styles.item}>
                <span className={styles.itemName}>
                  {a.name}
                  <span className={styles.itemMeta}>
                    {lengthText(a.lengthM)} · {a.fileName}
                  </span>
                </span>
                <span className={styles.actions}>
                  <button type="button" className={styles.secondary} onClick={() => void useAppStore.getState().openAlignment(a.id)}>
                    {t('SHOW')}
                  </button>
                  <button
                    type="button"
                    className={styles.quiet}
                    aria-label={`${t('DELETE LINE')} ${a.name}`}
                    onClick={() => void useAppStore.getState().deleteAlignment(a.id)}
                  >
                    {t('DELETE')}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** How many unreviewed boreholes inside the band are hidden, and how many cannot be checked (not on the map). */
export function LineNotes({ excludedUnreviewed, notOnMap }: { excludedUnreviewed: number; notOnMap: number }) {
  const t = useT();
  return (
    <>
      {excludedUnreviewed > 0 && (
        <p className={styles.note} data-testid="planned-line-hidden">
          {excludedUnreviewed}{' '}
          {t(excludedUnreviewed === 1 ? 'unreviewed borehole inside the band is hidden' : 'unreviewed boreholes inside the band are hidden')}
          {' — '}
          {t('turn on Include unreviewed')}
        </p>
      )}
      {notOnMap > 0 && (
        <p className={styles.hint} data-testid="planned-line-not-on-map">
          {notOnMap}{' '}
          {t(notOnMap === 1 ? 'borehole is not on the map and cannot be checked against the line' : 'boreholes are not on the map and cannot be checked against the line')}
        </p>
      )}
    </>
  );
}

interface TableProps {
  hits: AlignmentHit[];
  bufferM: number;
  selectedUid: string | null;
}

/** The boreholes along the line by chainage; a row shows its borehole on the map, DETAIL › opens it. */
export function HitTable({ hits, bufferM, selectedUid }: TableProps) {
  const t = useT();
  if (!hits.length) {
    return (
      <p className={styles.empty} role="status" data-testid="planned-line-empty">
        {t('No boreholes within')} {Math.round(bufferM * 10) / 10} m
      </p>
    );
  }
  const show = (uid: string) => useAppStore.getState().selectOnMap(uid);
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table} aria-label="Boreholes along the line" data-testid="planned-line-table">
        <thead>
          <tr>
            <th scope="col">{t('BOREHOLE')}</th>
            <th scope="col" className={styles.num}>
              {t('CHAINAGE')}
            </th>
            <th scope="col" className={styles.num}>
              {t('OFFSET')}
            </th>
            <th scope="col">{t('SIDE')}</th>
            <th scope="col" className={styles.num}>
              {t('DEPTH')}
            </th>
            <th scope="col">{t('STATUS')}</th>
            <th scope="col">
              <span className={styles.srOnly}>{t('Open')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {hits.map((h) => (
            <tr
              key={h.uid}
              className={`${styles.hitRow} ${h.uid === selectedUid ? styles.hitSelected : ''}`}
              tabIndex={0}
              aria-selected={h.uid === selectedUid}
              data-uid={h.uid}
              onClick={() => show(h.uid)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  show(h.uid);
                }
              }}
            >
              <td className={styles.hitId}>{h.id}</td>
              <td className={styles.num}>{chainageText(h.chainageM)}</td>
              <td className={styles.num}>{offsetText(h.offsetM)}</td>
              <td>{t(SIDE_LABEL[h.side])}</td>
              <td className={styles.num}>{depthText(h.depth)}</td>
              <td>
                <StatusChip status={h.reviewStatus} />
              </td>
              <td>
                <button
                  type="button"
                  className={styles.open}
                  onClick={(e) => {
                    e.stopPropagation();
                    useAppStore.getState().openBorehole(h.uid);
                  }}
                >
                  {t('DETAIL ›')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
