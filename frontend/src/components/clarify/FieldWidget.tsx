import type { ReactNode } from 'react';
import type { CrsCandidate, CrsVerdict, FormField } from '../../domain/types';
import styles from './Clarify.module.css';
import { crsOptionCandidates, parseNumber, type FieldInput } from './clarifyModel';
import { CrsPreviewMap } from './CrsPreviewMap';
import { scoreText, SWAP_TEXT, SWAP_TITLE, verdictColor, verdictText } from './crsView';
import { EvidenceCrop } from './EvidencePane';
import { MapPointPicker, type ReferencePoint } from './MapPointPicker';

/** The document's CRS candidates for a crs_picker field (GET /documents/{id}/crs-candidates). */
export interface CrsCandidatesState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  candidates: CrsCandidate[];
  error: string | null;
}

/** What a widget needs besides its field: page count, CRS candidates, reference pins, borehole IDs. */
export interface WidgetContext {
  /** Pages of the question's document, when known (page_range bounds). */
  pageCount: number | null;
  crs: CrsCandidatesState;
  /** The form's swap_axes answer (picks the candidate with that axis order), or null. */
  swapAxes: boolean | null;
  /** Other boreholes of the report on the map (map_point). */
  reference: readonly ReferencePoint[];
  /** Borehole ID per uid (preview tooltips). */
  labels: Record<string, string>;
}

interface Props {
  field: FormField;
  input: FieldInput;
  onChange(input: FieldInput): void;
  /** The error shown next to the field, or null. */
  error: string | null;
  /** Unique id prefix of the field's controls. */
  idBase: string;
  ctx: WidgetContext;
}

/** The field's label with the required mark. */
function Label({ field }: { field: FormField }) {
  return (
    <>
      {field.label}
      {field.required && (
        <span className={styles.req} aria-hidden="true">
          {' '}
          *
        </span>
      )}
    </>
  );
}

/**
 * One form field of a question, rendered by its widget (FRONTEND.md F12): text, number_unit (number
 * plus the server's units), select, boolean (two radios: no answer until one is picked),
 * map_point (a map click or two inputs), choose_reading (each reading as a card with its evidence
 * crop; "none of these" only when the field is optional), page_range (from / to) and crs_picker (the
 * document's candidates with verdict colours, notes and mini-map previews). The help text and the
 * error are tied to the control with aria-describedby.
 */
export function FieldWidget({ field: f, input, onChange, error, idBase, ctx }: Props) {
  const helpId = `${idBase}-help`;
  const errId = `${idBase}-error`;
  const describedBy = [f.help ? helpId : '', error ? errId : ''].filter(Boolean).join(' ') || undefined;
  const a11y = { 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy } as const;
  const help = f.help ? (
    <p id={helpId} className={styles.help}>
      {f.help}
    </p>
  ) : null;
  const err = error ? (
    <p id={errId} className={styles.fieldError}>
      {error}
    </p>
  ) : null;

  /** A field made of several controls: fieldset with the label as legend. */
  const group = (body: ReactNode, extra = '') => (
    <fieldset className={`${styles.field} ${styles.group} ${extra} ${error ? styles.fieldInvalid : ''}`} data-field={f.name} data-widget={f.widget}>
      <legend className={styles.label}>
        <Label field={f} />
      </legend>
      {help}
      {body}
      {err}
    </fieldset>
  );

  switch (f.widget) {
    case 'text': {
      const v = input.kind === 'text' ? input : { kind: 'text' as const, text: '' };
      return (
        <div className={`${styles.field} ${error ? styles.fieldInvalid : ''}`} data-field={f.name} data-widget={f.widget}>
          <label htmlFor={idBase} className={styles.label}>
            <Label field={f} />
          </label>
          {help}
          <input
            id={idBase}
            className={styles.input}
            type="text"
            value={v.text}
            required={f.required}
            {...a11y}
            onChange={(e) => onChange({ kind: 'text', text: e.target.value })}
          />
          {err}
        </div>
      );
    }

    case 'number_unit': {
      const v = input.kind === 'number_unit' ? input : { kind: 'number_unit' as const, number: '', unit: '' };
      // Mark the part that is wrong (both when the server's error names neither).
      const badNumber = parseNumber(v.number) === null;
      const badUnit = f.unitOptions.length > 0 && !f.unitOptions.includes(v.unit);
      const numberA11y = error && !badNumber && badUnit ? { ...a11y, 'aria-invalid': undefined } : a11y;
      const unitA11y = error && badNumber ? { ...a11y, 'aria-invalid': undefined } : a11y;
      return group(
        <div className={styles.inline}>
          <input
            id={idBase}
            className={`${styles.input} ${styles.number}`}
            type="text"
            inputMode="decimal"
            aria-label={`${f.label}: number`}
            value={v.number}
            required={f.required}
            {...numberA11y}
            onChange={(e) => onChange({ ...v, number: e.target.value })}
          />
          {f.unitOptions.length > 0 && (
            <select
              className={styles.select}
              aria-label={`${f.label}: unit`}
              value={v.unit}
              required={f.required}
              {...unitA11y}
              onChange={(e) => onChange({ ...v, unit: e.target.value })}
            >
              <option value="">Unit…</option>
              {f.unitOptions.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          )}
        </div>,
      );
    }

    case 'select': {
      const v = input.kind === 'choice' ? input : { kind: 'choice' as const, index: null, none: false };
      return (
        <div className={`${styles.field} ${error ? styles.fieldInvalid : ''}`} data-field={f.name} data-widget={f.widget}>
          <label htmlFor={idBase} className={styles.label}>
            <Label field={f} />
          </label>
          {help}
          <select
            id={idBase}
            className={styles.select}
            value={v.index === null ? '' : String(v.index)}
            required={f.required}
            {...a11y}
            onChange={(e) => onChange({ kind: 'choice', index: e.target.value === '' ? null : Number(e.target.value), none: false })}
          >
            <option value="">Choose…</option>
            {f.options.map((o, i) => (
              <option key={i} value={String(i)}>
                {o.label}
              </option>
            ))}
          </select>
          {err}
        </div>
      );
    }

    case 'boolean': {
      const v = input.kind === 'boolean' ? input.value : null;
      const radio = (value: boolean, text: string) => (
        <label className={styles.choice}>
          <input
            type="radio"
            name={idBase}
            checked={v === value}
            required={f.required}
            {...a11y}
            onChange={() => onChange({ kind: 'boolean', value })}
          />
          {text}
        </label>
      );
      return group(
        <div className={styles.inline} role="radiogroup" aria-label={f.label}>
          {radio(true, 'Yes')}
          {radio(false, 'No')}
        </div>,
      );
    }

    case 'map_point': {
      const v = input.kind === 'point' ? input : { kind: 'point' as const, lat: '', lon: '' };
      return group(
        <>
          <MapPointPicker
            lat={v.lat}
            lon={v.lon}
            reference={ctx.reference}
            label={`${f.label}: click the map to place the point`}
            onChange={(lat, lon) => onChange({ kind: 'point', lat, lon })}
          />
          <div className={styles.inline}>
            <label className={styles.small}>
              Latitude (WGS84)
              <input
                id={idBase}
                className={`${styles.input} ${styles.number}`}
                type="text"
                inputMode="decimal"
                value={v.lat}
                {...a11y}
                onChange={(e) => onChange({ ...v, lat: e.target.value })}
              />
            </label>
            <label className={styles.small}>
              Longitude (WGS84)
              <input
                className={`${styles.input} ${styles.number}`}
                type="text"
                inputMode="decimal"
                value={v.lon}
                {...a11y}
                onChange={(e) => onChange({ ...v, lon: e.target.value })}
              />
            </label>
          </div>
        </>,
      );
    }

    case 'choose_reading': {
      const v = input.kind === 'choice' ? input : { kind: 'choice' as const, index: null, none: false };
      return group(
        <div className={styles.readings} role="radiogroup" aria-label={f.label} aria-required={f.required || undefined}>
          {f.options.map((o, i) => (
            <label key={i} className={`${styles.reading} ${v.index === i && !v.none ? styles.readingPicked : ''}`}>
              {o.evidence ? <EvidenceCrop evidence={o.evidence} /> : <span className={styles.cropNote}>No page region for this reading</span>}
              <span className={styles.readingRow}>
                <input
                  type="radio"
                  name={idBase}
                  checked={v.index === i && !v.none}
                  {...a11y}
                  onChange={() => onChange({ kind: 'choice', index: i, none: false })}
                />
                <span className={styles.readingLabel}>{o.label}</span>
              </span>
            </label>
          ))}
          {!f.required && (
            <label className={`${styles.reading} ${styles.readingNone} ${v.none ? styles.readingPicked : ''}`}>
              <span className={styles.readingRow}>
                <input
                  type="radio"
                  name={idBase}
                  checked={v.none}
                  {...a11y}
                  onChange={() => onChange({ kind: 'choice', index: null, none: true })}
                />
                <span className={styles.readingLabel}>None of these</span>
              </span>
            </label>
          )}
        </div>,
      );
    }

    case 'page_range': {
      const v = input.kind === 'range' ? input : { kind: 'range' as const, from: '', to: '' };
      const max = ctx.pageCount ?? undefined;
      return group(
        <div className={styles.inline}>
          <label className={styles.small}>
            From page
            <input
              id={idBase}
              className={`${styles.input} ${styles.page}`}
              type="number"
              min={1}
              max={max}
              step={1}
              value={v.from}
              {...a11y}
              onChange={(e) => onChange({ ...v, from: e.target.value })}
            />
          </label>
          <label className={styles.small}>
            To page
            <input
              className={`${styles.input} ${styles.page}`}
              type="number"
              min={1}
              max={max}
              step={1}
              value={v.to}
              {...a11y}
              onChange={(e) => onChange({ ...v, to: e.target.value })}
            />
          </label>
          {ctx.pageCount !== null && <span className={styles.small}>of {ctx.pageCount} pages</span>}
        </div>,
      );
    }

    case 'crs_picker': {
      const v = input.kind === 'choice' ? input : { kind: 'choice' as const, index: null, none: false };
      return group(<CrsPicker field={f} index={v.index} onPick={(i) => onChange({ kind: 'choice', index: i, none: false })} ctx={ctx} a11y={a11y} />);
    }
  }
}

/** Text colour of a verdict note (readable shades of the verdict colours). */
const NOTE_CLASS: Record<CrsVerdict | 'none', string> = {
  match: styles.noteMatch,
  shifted: styles.noteShifted,
  out_of_range: styles.noteOut,
  none: styles.noteNeutral,
};

/** The crs_picker list: the server's options, each with its candidate's verdict and a mini-map; the picked one large. */
function CrsPicker({
  field: f,
  index,
  onPick,
  ctx,
  a11y,
}: {
  field: FormField;
  index: number | null;
  onPick(i: number): void;
  ctx: WidgetContext;
  a11y: { 'aria-invalid': true | undefined; 'aria-describedby': string | undefined };
}) {
  const matched = crsOptionCandidates(f, ctx.crs.candidates, ctx.swapAxes);
  const picked = index === null ? null : matched[index];
  return (
    <>
      <div className={styles.cands} role="radiogroup" aria-label={f.label} aria-required={f.required || undefined} {...a11y}>
        {f.options.map((o, i) => {
          const c = matched[i];
          const score = c ? scoreText(c) : '';
          return (
            <div key={i} className={styles.candRow}>
              <button
                type="button"
                role="radio"
                aria-checked={index === i}
                className={`${styles.cand} ${index === i ? styles.candPicked : ''}`}
                style={{ borderLeftColor: verdictColor(c?.verdict ?? null) }}
                onClick={() => onPick(i)}
              >
                <span className={styles.candName}>{o.label}</span>
                <span className={styles.candCode}>
                  {String(o.value)}
                  {score && ` · ${score}`}
                </span>
                {c?.swapAxes && (
                  <span className={styles.swap} title={SWAP_TITLE}>
                    {SWAP_TEXT}
                  </span>
                )}
                {c ? (
                  <span className={NOTE_CLASS[c.verdict ?? 'none']} data-verdict={c.verdict ?? 'none'}>
                    {verdictText(c)}
                  </span>
                ) : (
                  <span className={styles.noteNeutral}>
                    {ctx.crs.status === 'loading' ? 'Loading where it places the boreholes…' : 'No preview: the server lists no positions for this system'}
                  </span>
                )}
              </button>
              {c && <CrsPreviewMap candidate={c} size="small" />}
            </div>
          );
        })}
      </div>
      {ctx.crs.status === 'error' && <p className={styles.fieldError}>Positions could not be loaded: {ctx.crs.error}</p>}
      {picked && <CrsPreviewMap candidate={picked} size="large" labels={ctx.labels} />}
    </>
  );
}
