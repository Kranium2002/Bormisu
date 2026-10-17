import { useMemo, useRef, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { ChartExport } from '../../components/ChartExport';
import { useT } from '../../i18n';
import { useLocationRoute } from '../../routing/RouteSync';
import { boreholePath, routeUid, sheetPath } from '../../routing/urlState';
import { useBorehole, useDocument } from '../../store/appStore';
import { ProfileColumn, profileExportInfo, ProfileLegend } from '../detail/ProfileColumn';
import { SheetWithSource, useSourceLink } from './SheetSource';
import { sheetLang, sheetModel, sheetT, type SheetCell, type SheetLang } from './sheetModel';
import styles from './SheetScreen.module.css';

const LANGS: { lang: SheetLang; label: string }[] = [
  { lang: 'en', label: 'EN' },
  { lang: 'de', label: 'DE' },
];
const noop = () => undefined;

/**
 * A value on the sheet: grey italics when the source doesn't state it, `*` when not reviewed yet.
 * A value the record has is a button that looks like the text: hovering, focusing or clicking it
 * shows it in the original page (SheetWithSource reads its data-value-key).
 */
function Cell({ cell, mono = false }: { cell: SheetCell; mono?: boolean }) {
  const t = useT();
  const link = useSourceLink();
  const look = cell.missing ? styles.missing : mono ? styles.mono : '';
  const text = (
    <>
      {cell.text}
      {cell.unreviewed && <sup className={styles.unreviewed} aria-label="not reviewed yet">*</sup>}
    </>
  );
  if (!cell.key || !link) return <span className={look}>{text}</span>;
  const pinned = link.pinnedKey === cell.key;
  return (
    <button
      type="button"
      className={[styles.value, look, link.activeKey === cell.key ? styles.valueActive : '', pinned ? styles.valuePinned : ''].join(' ')}
      data-value-key={cell.key}
      title={t('Show in the original')}
      aria-pressed={pinned}
    >
      {text}
    </button>
  );
}

/** A layer row: hovering or clicking anywhere in it shows the layer's description in the original. */
function LayerRow({ valueKey, children }: { valueKey?: string; children: ReactNode }) {
  const link = useSourceLink();
  return (
    <tr data-value-key={valueKey} className={valueKey && link?.activeKey === valueKey ? styles.rowActive : undefined}>
      {children}
    </tr>
  );
}

/** A header field (label over value): hovering or clicking it shows its value in the original. */
function HeaderField({ valueKey, children }: { valueKey?: string; children: ReactNode }) {
  const link = useSourceLink();
  return (
    <div data-value-key={valueKey} className={`${styles.field} ${valueKey && link?.activeKey === valueKey ? styles.fieldActive : ''}`}>
      {children}
    </div>
  );
}

/**
 * The generated borehole sheet (/sheet/:uid): an A4 page filled from the record (header block, the
 * DIN 4023 profile next to the layer table, groundwater, samples and test results, review state, and
 * where it came from), printable as PDF. EN | DE on the sheet itself (?lang=, history replace; English
 * by default) switches its labels and shows the descriptions in English or as printed; the app's
 * own UI language doesn't change it. The original page is beside it (SheetWithSource): hovering or
 * clicking a value shows where it was read. Print CSS keeps only the page (@page A4).
 */
export function SheetScreen() {
  const t = useT();
  const route = useLocationRoute();
  const uid = routeUid(route);
  const b = useBorehole(uid);
  const doc = useDocument(b?.documentId);
  const navigate = useNavigate();
  const profileRef = useRef<SVGSVGElement>(null);
  const lang = sheetLang(route.kind === 'sheet' ? route.lang : null);
  const st = (en: string) => sheetT(lang, en);
  const model = useMemo(() => (b ? sheetModel(b, lang, { pages: doc?.pages ?? [], today: new Date() }) : null), [b, lang, doc]);
  if (!b || !model) return null;

  const setLang = (next: SheetLang) => {
    if (next !== lang) void navigate(sheetPath(b.uid, next === 'en' ? null : next), { replace: true });
  };

  return (
    <div className={styles.screen} data-screen-label="Borehole sheet">
      <div className={styles.toolbar}>
        <Link className={styles.back} to={boreholePath(b.uid)}>
          {t('‹ DETAIL')}
        </Link>
        <span className={styles.toolbarTitle}>{t('BOREHOLE SHEET')} · {b.id}</span>
        <div className={styles.spacer} />
        <div className={styles.langs} role="group" aria-label={t('Sheet language')}>
          {LANGS.map((l) => (
            <button key={l.lang} type="button" className={styles.lang} aria-pressed={lang === l.lang} onClick={() => setLang(l.lang)}>
              {l.label}
            </button>
          ))}
        </div>
        <button type="button" className={styles.print} onClick={() => window.print()}>
          {t('PRINT / SAVE AS PDF')}
        </button>
      </div>

      <SheetWithSource key={b.uid} borehole={b}>
        <article className={styles.page} lang={lang} aria-label={`${st('Borehole sheet')} ${b.id}`}>
          <header className={styles.pageHead}>
            <img className={styles.logo} src="/logo.png" alt="" width={28} height={28} />
            <div>
              <div className={styles.kicker}>{model.title} · DIN 4023</div>
              <h1 className={styles.id}>{b.id}</h1>
            </div>
            <div className={styles.reviewState}>
              {model.review.text}
              {model.review.approved < model.review.total && <div className={styles.reviewNote}>* {st('not reviewed yet')}</div>}
            </div>
          </header>

          <section className={`${styles.block} ${styles.fields}`} aria-label={st('Borehole')}>
            {model.header.map((f) => (
              <HeaderField key={f.label} valueKey={f.cell.key}>
                <div className={styles.fieldLabel}>{f.label}</div>
                <div className={styles.fieldValue}>
                  <Cell cell={f.cell} />
                </div>
              </HeaderField>
            ))}
          </section>

          <section className={`${styles.block} ${styles.profileRow}`} aria-label={st('Profile and layers')}>
            <div className={styles.profile}>
              <div className={`${styles.blockHead} ${styles.profileHead}`}>
                <span>
                  {st('PROFILE')} <span className={styles.note}>DIN 4023 · {model.depthNote}</span>
                </span>
                <ChartExport target={profileRef} info={profileExportInfo(b, { t: st, de: lang === 'de' })} />
              </div>
              <ProfileColumn ref={profileRef} borehole={b} selectedLayer={-1} onSelectLayer={noop} onOpenSource={noop} readOnly t={st} />
            </div>
            <div className={styles.layers}>
              <div className={styles.blockHead}>{st('LAYERS')}</div>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>{st('From–to (m)')}</th>
                    <th>{model.descriptionHead}</th>
                    <th>DIN 4023</th>
                    <th>{st('Consistency / density')}</th>
                    <th>SPT</th>
                    {model.hasCore && <th>TCR / RQD (%)</th>}
                  </tr>
                </thead>
                <tbody>
                  {model.layers.map((l) => (
                    <LayerRow key={l.n} valueKey={l.description.key}>
                      <td className={`${styles.mono} ${styles.nowrap}`}>{l.range}</td>
                      <td>
                        <Cell cell={l.description} />
                      </td>
                      <td className={styles.mono}>{l.din}</td>
                      <td>{l.consistency}</td>
                      <td className={styles.nowrap}>
                        <Cell cell={l.spt} mono />
                      </td>
                      {model.hasCore && (
                        <td className={`${styles.mono} ${styles.nowrap}`}>
                          <Cell cell={l.tcr} mono /> / <Cell cell={l.rqd} mono />
                        </td>
                      )}
                    </LayerRow>
                  ))}
                  {model.layers.length === 0 && (
                    <tr>
                      <td colSpan={6} className={styles.missing}>{st('no layers in source')}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className={styles.block} aria-label={st('Legend')}>
            <ProfileLegend borehole={b} readOnly de={lang === 'de'} t={st} />
          </section>

          <section className={styles.block} aria-label={st('Groundwater')}>
            <div className={styles.blockHead}>{st('GROUNDWATER')}</div>
            {model.groundwater.length ? (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>{st('Reading')}</th>
                    <th>{st('Depth')}</th>
                    <th>{st('Date')}</th>
                  </tr>
                </thead>
                <tbody>
                  {model.groundwater.map((g, i) => (
                    <tr key={i}>
                      <td>{g.type}</td>
                      <td>
                        <Cell cell={g.depth} mono />
                      </td>
                      <td className={styles.mono}>{g.date}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className={styles.missing}>{st('No groundwater reading in source')}</p>
            )}
          </section>

          <section className={styles.block} aria-label={st('Samples and test results')}>
            <div className={styles.blockHead}>{st('SAMPLES AND TEST RESULTS')}</div>
            {model.tests.rows.length ? (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>{st('Sample')}</th>
                    <th>{st('Type')}</th>
                    <th>{st('Depth (m)')}</th>
                    {model.tests.columns.map((c) => (
                      <th key={c}>{st(c)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {model.tests.rows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.sample}</td>
                      <td>{r.typeCode}</td>
                      <td className={r.depth.missing ? styles.missing : styles.mono}>{r.depth.missing ? st(r.depth.text) : r.depth.text}</td>
                      {model.tests.columns.map((c) => {
                        const v = r.cells[c];
                        return (
                          <td key={c} className={styles.mono}>
                            {v ? v.text : '–'}
                            {v?.unreviewed && <sup className={styles.unreviewed}>*</sup>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className={styles.missing}>{st('No samples or test results in source')}</p>
            )}
          </section>

          <footer className={styles.footer}>{model.footer}</footer>
        </article>
      </SheetWithSource>
    </div>
  );
}
