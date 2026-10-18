/**
 * /report: the printable report of a selection of boreholes (a planned line's hits by chainage, an area
 * drawn on the map, a search result set, the LIST), on A4 like the borehole sheet:
 *
 * - title, date and the selection (line with length and distance, or the shape and its area);
 * - a static map extract with the boreholes numbered as in the summary table;
 * - the summary table: ID, name, WGS84 position, coordinates as printed with their system, ground level,
 *   final depth, review status, source file and page; chainage, offset and side for a line;
 * - the combined soil chart (all profiles on one axis, below ground or by elevation; along the line by
 *   chainage), its DIN legend, PNG / SVG download;
 * - per borehole: header, layer table (depths, description, DIN code, stratigraphy) and its DIN 4023
 *   profile, CHAPTER_SIZE boreholes per screen page (all of them when printing);
 * - CSV / xlsx of every layer of the selection.
 *
 * Values not approved yet are marked `*`, low-confidence or flagged ones `?`; what the source doesn't
 * state reads "not in source". Labels follow the app's language (EN | DE).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link } from 'react-router';
import { ChartExport } from '../components/ChartExport';
import { EmptyState } from '../components/EmptyState';
import { errorText } from '../data/errors';
import { DIN_UNKNOWN_FILL, dinFill, dinNeedsUnderlay } from '../domain/din';
import type { Borehole } from '../domain/types';
import type { ChartExportInfo } from '../export/chartImage';
import { downloadBlob } from '../export/download';
import type { Cell } from '../export/standardXlsx';
import { useLang } from '../i18n';
import { useLocationRoute } from '../routing/RouteSync';
import { boreholePath, mapPath, type ReportUrlState } from '../routing/urlState';
import { ProfileColumn } from '../screens/detail/ProfileColumn';
import { sheetT, type SheetLang } from '../screens/sheet/sheetModel';
import { useAppStore } from '../store/appStore';
import { canAlignByElevation, CHART_MAX, combinedChart, type ChartMode } from './combinedChart';
import { CombinedProfiles } from './CombinedProfiles';
import { layersCsv, layersXlsx, reportFileName, type LineInfo } from './layerExport';
import { orderedRecords, reportModel, sourceText, type ReportBorehole, type ReportCell, type ReportModel, type ReportSelection, type SummaryRow } from './reportModel';
import { ReportMap } from './ReportMap';
import styles from './ReportScreen.module.css';
import { useReportData } from './useReportData';
import type { ExtractInput } from './mapExtract';

/** Boreholes per page of the per-borehole section on screen. */
export const CHAPTER_SIZE = 10;

const NO_URL: ReportUrlState = { rs: null, line: null, buffer: null, unrev: null };

const noop = () => {};

export function ReportScreen() {
  const route = useLocationRoute();
  const url = route.kind === 'report' ? route : NO_URL;
  const data = useReportData(url);
  const lang: SheetLang = useLang((s) => s.lang);
  const t = (en: string) => sheetT(lang, en);

  if (data.state === 'none') {
    return (
      <div className={styles.screen}>
        <EmptyState title="NO SELECTION" message="Select boreholes first: draw an area or a planned line on the map, search, or open LIST, then choose EXPORT REPORT." />
      </div>
    );
  }
  if (data.state === 'error') {
    return (
      <div className={styles.screen}>
        <EmptyState tone="error" title="REPORT NOT AVAILABLE" message={`${t('The selection could not be loaded')}: ${data.message}`} />
      </div>
    );
  }
  if (data.state === 'loading') {
    return (
      <div className={styles.screen}>
        <div className={styles.loading} role="status" aria-live="polite">
          <p className={styles.loadingTitle}>{t('LOADING')}</p>
          <p>{data.total == null ? t('Loading the selection…') : `${t('Loading the boreholes…')} ${data.loaded} / ${data.total}`}</p>
        </div>
      </div>
    );
  }
  return <Report selection={data.selection} records={data.records} missing={data.missing} lang={lang} />;
}

interface ReportProps {
  selection: ReportSelection;
  records: Borehole[];
  missing: number;
  lang: SheetLang;
}

function Report({ selection, records, missing, lang }: ReportProps) {
  const t = (en: string) => sheetT(lang, en);
  const showToast = useAppStore((s) => s.showToast);
  const [today] = useState(() => new Date());
  const ordered = useMemo(() => orderedRecords(selection, records), [selection, records]);
  const model = useMemo(() => reportModel(lang, selection, ordered, { today, missing }), [lang, selection, ordered, today, missing]);
  const lines = useMemo(() => {
    if (selection.kind !== 'line') return undefined;
    return new Map<string, LineInfo>(selection.result.hits.map((h) => [h.uid, { chainageM: h.chainageM, offsetM: h.offsetM, side: h.side }]));
  }, [selection]);

  // Per-borehole section: one page on screen, all of it in print.
  const [chapter, setChapter] = useState(0);
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    const before = () => flushSync(() => setPrinting(true));
    const after = () => setPrinting(false);
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
    };
  }, []);
  const print = () => {
    flushSync(() => setPrinting(true));
    window.print();
  };

  const fileBase = selection.kind === 'line' ? selection.alignment.name : model.subtitle;
  const summaryCells = useMemo(() => summaryTable(model, lang), [model, lang]);
  const download = async (kind: 'csv' | 'xlsx') => {
    try {
      const blob = kind === 'csv' ? layersCsv(ordered, lines) : await layersXlsx(ordered, summaryCells, lines);
      downloadBlob(blob, reportFileName(fileBase, 'layers', kind));
      showToast(t('Layers downloaded'));
    } catch (e) {
      showToast(`${t('The download failed')}: ${errorText(e)}`);
    }
  };

  const pages = Math.max(1, Math.ceil(model.boreholes.length / CHAPTER_SIZE));
  const page = Math.min(chapter, pages - 1);
  const shownBoreholes = printing ? model.boreholes : model.boreholes.slice(page * CHAPTER_SIZE, (page + 1) * CHAPTER_SIZE);
  const recordOf = useMemo(() => new Map(ordered.map((b) => [b.uid, b])), [ordered]);
  const titleId = useId();

  return (
    <div className={styles.screen} data-screen-label="Report">
      <div className={styles.toolbar}>
        <Link className={styles.back} to={mapPath({ at: null, sel: null, rs: selection.resultSet?.id ?? null })}>
          {t('‹ BACK')}
        </Link>
        <span className={styles.toolbarTitle}>{model.subtitle}</span>
        <button type="button" className={styles.secondary} onClick={() => void download('csv')}>
          {t('LAYERS CSV')}
        </button>
        <button type="button" className={styles.secondary} onClick={() => void download('xlsx')}>
          {t('LAYERS XLSX')}
        </button>
        <button type="button" className={styles.print} onClick={print}>
          {t('PRINT / SAVE AS PDF')}
        </button>
      </div>

      <article className={styles.page} aria-labelledby={titleId} data-testid="report">
        <header className={styles.head}>
          <div>
            <h1 id={titleId} className={styles.title}>
              {model.title}
            </h1>
            <p className={styles.subtitle}>{model.subtitle}</p>
          </div>
          <p className={styles.date}>{model.date}</p>
        </header>

        <section className={`${styles.block} ${styles.facts}`} aria-label={t('Selection')}>
          <dl className={styles.factList}>
            {model.facts.map((f) => (
              <div key={f.label} className={styles.fact}>
                <dt>{f.label}</dt>
                <dd>{f.text}</dd>
              </div>
            ))}
          </dl>
          {model.missing > 0 && (
            <p className={styles.warn} role="note">
              {model.missing} {t(model.missing === 1 ? 'borehole of the selection could not be loaded and is not in the report' : 'boreholes of the selection could not be loaded and are not in the report')}
            </p>
          )}
        </section>

        <section className={`${styles.block} ${styles.mapBlock}`} aria-label={t('Map')}>
          <ReportMap
            input={mapInput(selection, model.summary, recordOf)}
            label={`${t('Map of the selection')}: ${model.subtitle}`}
            attribution="© OpenStreetMap contributors"
            emptyText={t('No borehole of the selection has a map position.')}
          />
        </section>

        <SummaryTable model={model} t={t} />

        <ChartSection model={model} selection={selection} records={ordered} lang={lang} fileBase={fileBase} />

        <section className={styles.chapters} aria-labelledby={`${titleId}-bh`}>
          <h2 id={`${titleId}-bh`} className={styles.h2}>
            {t('Borehole details')}
          </h2>
          {pages > 1 && !printing && <Pager page={page} pages={pages} total={model.boreholes.length} onPage={setChapter} t={t} />}
          {shownBoreholes.map((rb) => (
            <BoreholeBlock key={rb.uid} rb={rb} borehole={recordOf.get(rb.uid)!} lang={lang} />
          ))}
          {pages > 1 && !printing && <Pager page={page} pages={pages} total={model.boreholes.length} onPage={setChapter} t={t} />}
        </section>

        <footer className={styles.footer}>
          <p>{model.footer}</p>
          <p>
            <span className={styles.markLegend}>
              <sup className={styles.unreviewed}>*</sup> {t('not reviewed yet')}
            </span>
            <span className={styles.markLegend}>
              <sup className={styles.unsure}>?</sup> {t('low confidence or flagged')}
            </span>
            <span className={styles.markLegend}>
              <span className={styles.missing}>{t('not in source')}</span> {t('the source does not state it')}
            </span>
          </p>
        </footer>
      </article>
    </div>
  );
}

/** A report cell: its text, grey italics when not in the source, `*` unreviewed, `?` unsure. */
function CellText({ cell, mono }: { cell: ReportCell; mono?: boolean }) {
  return (
    <span className={`${cell.missing ? styles.missing : ''} ${mono ? styles.mono : ''}`}>
      {cell.text}
      {cell.unreviewed && (
        <sup className={styles.unreviewed} aria-label="not reviewed yet">
          *
        </sup>
      )}
      {cell.unsure && (
        <sup className={styles.unsure} aria-label="low confidence or flagged">
          ?
        </sup>
      )}
    </span>
  );
}

function SummaryTable({ model, t }: { model: ReportModel; t: (en: string) => string }) {
  return (
    <section className={styles.block} aria-label={t('Boreholes')}>
      <h2 className={styles.h2}>
        {t('Boreholes')} ({model.summary.length})
      </h2>
      {model.summary.length ? (
        <table className={styles.table} data-testid="report-summary">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{t('Borehole')}</th>
              {model.hasLine && <th scope="col">{t('Chainage')}</th>}
              {model.hasLine && <th scope="col">{t('Offset')}</th>}
              {model.hasLine && <th scope="col">{t('Side')}</th>}
              <th scope="col">{t('Position (WGS84)')}</th>
              <th scope="col">{t('Coordinates as printed')}</th>
              <th scope="col">{t('Ground level')}</th>
              <th scope="col">{t('Final depth')}</th>
              <th scope="col">{t('Status')}</th>
              <th scope="col">{t('Source')}</th>
            </tr>
          </thead>
          <tbody>
            {model.summary.map((r) => (
              <SummaryLine key={r.uid} r={r} hasLine={model.hasLine} />
            ))}
          </tbody>
        </table>
      ) : (
        <p className={styles.missing}>{t('The selection holds no boreholes.')}</p>
      )}
    </section>
  );
}

function SummaryLine({ r, hasLine }: { r: SummaryRow; hasLine: boolean }) {
  const lang: SheetLang = useLang((s) => s.lang);
  return (
    <tr data-uid={r.uid}>
      <td className={styles.num}>{r.no}</td>
      <td>
        <Link className={styles.idLink} to={boreholePath(r.uid)}>
          {r.id}
        </Link>
        {!r.name.missing && (
          <span className={styles.sub}>
            <CellText cell={r.name} />
          </span>
        )}
      </td>
      {hasLine && <td className={styles.num}>{r.line?.chainage}</td>}
      {hasLine && <td className={styles.num}>{r.line?.offset}</td>}
      {hasLine && <td>{r.line?.side}</td>}
      <td className={r.wgs84.missing ? styles.missing : styles.mono}>{r.wgs84.text}</td>
      <td>
        <CellText cell={r.printed} />
      </td>
      <td>
        <CellText cell={r.groundLevel} />
      </td>
      <td>
        <CellText cell={r.finalDepth} />
      </td>
      <td>{r.statusLabel}</td>
      <td className={styles.source}>{sourceText(lang, r.source)}</td>
    </tr>
  );
}

/** The static map's input: numbered points, the line and its band, or the drawn area. */
function mapInput(selection: ReportSelection, rows: readonly SummaryRow[], records: ReadonlyMap<string, Borehole>): ExtractInput {
  const points = rows.flatMap((r) => {
    const b = records.get(r.uid);
    return b && b.lat != null && b.lng != null ? [{ no: r.no, lat: b.lat, lng: b.lng, status: r.status }] : [];
  });
  if (selection.kind === 'line') return { points, line: selection.alignment.parts, band: selection.result.band };
  if (selection.kind === 'area') return { points, area: selection.area };
  return { points };
}

interface ChartProps {
  model: ReportModel;
  selection: ReportSelection;
  records: Borehole[];
  lang: SheetLang;
  fileBase: string;
}

function ChartSection({ model, selection, records, lang, fileBase }: ChartProps) {
  const t = (en: string) => sheetT(lang, en);
  const [mode, setMode] = useState<ChartMode>('depth');
  const byElevation = canAlignByElevation(records);
  const chainages = useMemo(
    () => (selection.kind === 'line' ? new Map(selection.result.hits.map((h) => [h.uid, h.chainageM])) : undefined),
    [selection],
  );
  const chart = useMemo(
    () =>
      combinedChart(records, {
        mode: byElevation ? mode : 'depth',
        chainages,
        lineLengthM: selection.kind === 'line' ? selection.result.lengthM || selection.alignment.lengthM : undefined,
      }),
    [records, mode, byElevation, chainages, selection],
  );
  const ref = useRef<SVGSVGElement>(null);
  const name = useId();
  const axisTitle = chart.mode === 'elevation' ? `${t('Elevation')} (m${chart.datum ? ` ${chart.datum}` : ''})` : t('Depth below ground (m)');
  const capped = chart.shown < chart.eligible;
  const cappedNote = capped
    ? lang === 'de'
      ? `Gezeigt: die ersten ${chart.shown} von ${chart.eligible} Bohrungen${selection.kind === 'line' ? ' nach Stationierung' : ''}.`
      : `Showing the first ${chart.shown} of ${chart.eligible} boreholes${selection.kind === 'line' ? ' by chainage' : ''}.`
    : '';
  const noGlNote =
    chart.withoutGroundLevel.length > 0
      ? `${chart.withoutGroundLevel.length} ${t(chart.withoutGroundLevel.length === 1 ? 'borehole without a stated ground level is not shown' : 'boreholes without a stated ground level are not shown')}`
      : '';
  const info: ChartExportInfo = {
    caption: `${t('Soil profiles')} · ${model.subtitle}`,
    subtitle: `${axisTitle} · ${model.date}`,
    legend: [
      ...chart.legend.map((l) => ({ fill: dinFill(l.code), underlay: dinNeedsUnderlay(l.code), code: l.code, name: l.entry ? (lang === 'de' ? l.entry.nameDe : l.entry.nameEn) : t('unknown code') })),
      ...(chart.uncoded ? [{ fill: DIN_UNKNOWN_FILL, code: '–', name: t('no DIN code in the record') }] : []),
    ],
    note: [cappedNote, noGlNote].filter(Boolean).join(' '),
    fileBase,
  };
  return (
    <section className={`${styles.block} ${styles.chartSection}`} aria-labelledby={`${name}-h`}>
      <div className={styles.chartHead}>
        <h2 id={`${name}-h`} className={styles.h2}>
          {t('Soil profiles')}
        </h2>
        {byElevation && (
          <div className={styles.modes} role="radiogroup" aria-label={t('Vertical axis')}>
            {(['depth', 'elevation'] as const).map((m) => (
              <label key={m} className={`${styles.mode} ${mode === m ? styles.modeOn : ''}`}>
                <input type="radio" name={name} value={m} checked={mode === m} onChange={() => setMode(m)} className={styles.radio} />
                {t(m === 'depth' ? 'BELOW GROUND' : 'BY ELEVATION')}
              </label>
            ))}
          </div>
        )}
        <ChartExport target={ref} info={info} suffix="soil-chart" />
      </div>
      {chart.columns.length ? (
        <div className={styles.chartWrap}>
          <CombinedProfiles ref={ref} chart={chart} label={`${t('Soil profiles')}: ${model.subtitle}`} axisTitle={axisTitle} />
        </div>
      ) : (
        <p className={styles.missing}>{t('No profile to draw.')}</p>
      )}
      {(cappedNote || noGlNote) && (
        <p className={styles.note} data-testid="chart-note">
          {[cappedNote, noGlNote].filter(Boolean).join(' ')}
        </p>
      )}
      {(chart.legend.length > 0 || chart.uncoded) && (
        <ul className={styles.legend} aria-label={t('DIN 4023 legend')}>
          {chart.legend.map((l) => (
            <li key={l.code} className={styles.legendItem}>
              <svg width={28} height={14} aria-hidden="true">
                {dinNeedsUnderlay(l.code) && <rect width={28} height={14} fill="#FFFFFF" />}
                <rect width={28} height={14} fill={dinFill(l.code)} stroke="#1A1A1A" strokeWidth={0.6} />
              </svg>
              <span className={styles.mono}>{l.code}</span> {l.entry ? (lang === 'de' ? l.entry.nameDe : l.entry.nameEn) : t('unknown code')}
            </li>
          ))}
          {chart.uncoded && (
            <li className={styles.legendItem}>
              <svg width={28} height={14} aria-hidden="true">
                <rect width={28} height={14} fill={DIN_UNKNOWN_FILL} stroke="#1A1A1A" strokeWidth={0.6} />
              </svg>
              <span className={styles.mono}>–</span> {t('no DIN code in the record')}
            </li>
          )}
        </ul>
      )}
      <p className={styles.hintNote}>{lang === 'de' ? `Höchstens ${CHART_MAX} Profile pro Diagramm.` : `At most ${CHART_MAX} profiles per chart.`}</p>
    </section>
  );
}

function Pager({ page, pages, total, onPage, t }: { page: number; pages: number; total: number; onPage(p: number): void; t: (en: string) => string }) {
  const from = page * CHAPTER_SIZE + 1;
  const to = Math.min(total, (page + 1) * CHAPTER_SIZE);
  return (
    <nav className={styles.pager} aria-label={t('Borehole pages')}>
      <button type="button" className={styles.secondary} disabled={page === 0} onClick={() => onPage(page - 1)}>
        {t('‹ PREVIOUS')}
      </button>
      <span aria-live="polite">
        {from}–{to} / {total}
      </span>
      <button type="button" className={styles.secondary} disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
        {t('NEXT ›')}
      </button>
    </nav>
  );
}

function BoreholeBlock({ rb, borehole, lang }: { rb: ReportBorehole; borehole: Borehole; lang: SheetLang }) {
  const t = (en: string) => sheetT(lang, en);
  const id = useId();
  return (
    <section className={styles.bh} aria-labelledby={id} data-uid={rb.uid}>
      <h3 id={id} className={styles.h3}>
        {rb.no} · {rb.id}
      </h3>
      <p className={styles.bhMeta}>
        {sourceText(lang, rb.source)} · {rb.review}
      </p>
      <div className={styles.bhRow}>
        <div className={styles.profile}>
          <ProfileColumn borehole={borehole} selectedLayer={-1} onSelectLayer={noop} onOpenSource={noop} readOnly t={t} />
        </div>
        <div className={styles.bhBody}>
          <dl className={styles.header}>
            {rb.header.map((h) => (
              <div key={h.label} className={styles.headerField}>
                <dt>{h.label}</dt>
                <dd>
                  <CellText cell={h.cell} />
                </dd>
              </div>
            ))}
          </dl>
          <table className={styles.table}>
            <caption className={styles.srOnly}>
              {t('Layers of')} {rb.id}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('From–to (m)')}</th>
                <th scope="col">{rb.sheet.descriptionHead}</th>
                <th scope="col">DIN 4023</th>
                <th scope="col">{t('Stratigraphy')}</th>
              </tr>
            </thead>
            <tbody>
              {rb.layers.length ? (
                rb.layers.map((l) => (
                  <tr key={l.n}>
                    <td className={styles.range}>{l.range}</td>
                    <td>
                      <CellText cell={l.description} />
                    </td>
                    <td className={styles.mono}>{l.din}</td>
                    <td>
                      <CellText cell={l.strat} />
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className={styles.missing}>
                    {t('no layers in source')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

/** The summary table as cells (the xlsx "Boreholes" sheet). */
function summaryTable(model: ReportModel, lang: SheetLang): Cell[][] {
  const head = ['No', 'BoreholeID', 'BoreholeName', ...(model.hasLine ? ['Chainage', 'Offset', 'Side'] : []), 'WGS84', 'CoordinatesAsPrinted', 'GroundLevel', 'FinalDepth', 'Status', 'Source'];
  const txt = (c: ReportCell) => (c.missing ? 'not in source' : c.text);
  return [
    head,
    ...model.summary.map((r) => [
      r.no,
      r.id,
      r.name.missing ? '' : r.name.text,
      ...(model.hasLine ? [r.line?.chainage ?? '', r.line?.offset ?? '', r.line?.side ?? ''] : []),
      r.wgs84.text,
      txt(r.printed),
      txt(r.groundLevel),
      txt(r.finalDepth),
      r.statusLabel,
      sourceText(lang, r.source),
    ]),
  ];
}
