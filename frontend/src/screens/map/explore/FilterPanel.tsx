/**
 * FILTERS section of the explore panel (FRONTEND.md F10, LGRB "Filter"): only what the contract's
 * BoreholeFilter supports. The panel writes through to the store's filter as you change it, so an
 * area drawn on the map runs with what the panel shows; the depth fields keep the typed text and are
 * validated (each a depth in metres, minimum not above maximum) before APPLY sends anything. APPLY
 * runs the filter as a result set (its id goes into the URL); RESET clears the set and the panel.
 * The result set's summary and errors are shown above the RESULTS table (the error is announced
 * there, role=alert); a failed request's detail is repeated next to APPLY, so it is seen also while
 * the panel lies over the map or fills the screen.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { BoreholeFilter, BoreholeReviewStatus } from '../../../domain/types';
import { useAppStore } from '../../../store/appStore';
import styles from './FilterPanel.module.css';
import {
  areaText,
  depthTextOf,
  dinGroups,
  dinName,
  fromTri,
  knownProjects,
  parseDepthText,
  submitFilter,
  toggled,
  toTri,
  type DepthField,
  type DepthTexts,
  type FilterErrors,
  type Tri,
} from './filterModel';

const TRI: { value: Tri; label: string }[] = [
  { value: 'any', label: 'Any' },
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

const REVIEW: { value: BoreholeReviewStatus; label: string }[] = [
  { value: 'unreviewed', label: 'Unreviewed' },
  { value: 'in_review', label: 'In review' },
  { value: 'approved', label: 'Approved' },
];

/**
 * A text filter as typed, or null while it is blank: an area drawn on the map runs the store's filter
 * without APPLY's trimming, so whitespace alone never goes out as a filter.
 */
const textOf = (value: string): string | null => (value.trim() ? value : null);

/** Element id of each depth field (focus goes to the first invalid one). */
const DEPTH_ID: Record<DepthField, string> = {
  minDepth: 'filter-min-depth',
  maxDepth: 'filter-max-depth',
  lithologyMinDepth: 'filter-lith-depth',
};

export interface FilterPanelViewProps {
  filter: BoreholeFilter;
  /** The depth fields as typed. */
  texts: DepthTexts;
  /** Errors of the last APPLY, per depth field. */
  errors: FilterErrors;
  /** Text of the DIN code search. */
  dinQuery: string;
  documents: { id: string; name: string }[];
  /** Project names the map knows (suggestions for the project field). */
  projects: string[];
  /** A result-set request is running. */
  busy: boolean;
  /**
   * Why the last result-set request failed (the server's detail), or null. Shown next to APPLY as
   * plain text: the alert that announces it is the result-set line above the RESULTS table, which
   * stays in the page however the panel is laid out, so it is announced once.
   */
  error: string | null;
  onChange(patch: Partial<BoreholeFilter>): void;
  onDepthText(field: DepthField, text: string): void;
  onDinQuery(text: string): void;
  onApply(): void;
  onReset(): void;
}

/** A depth field: label, typed text, its error. */
function DepthInput({ field, label, text, error, disabled, describedBy, onText }: {
  field: DepthField;
  label: string;
  text: string;
  error?: string;
  disabled?: boolean;
  describedBy?: string;
  onText(field: DepthField, text: string): void;
}) {
  const id = DEPTH_ID[field];
  const described = [error ? `${id}-error` : null, describedBy ?? null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <input
        id={id}
        className={styles.input}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={text}
        disabled={disabled}
        aria-invalid={!!error}
        aria-describedby={described}
        onChange={(e) => onText(field, e.target.value)}
      />
    </div>
  );
}

/** The section's form, from props (server-rendered in tests). */
export function FilterPanelView(p: FilterPanelViewProps) {
  const { filter, texts, errors, busy, onChange } = p;
  const groups = useMemo(() => dinGroups(p.dinQuery), [p.dinQuery]);
  const codes = filter.dinCodes;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    p.onApply();
  };
  const tri = (name: string, legend: string, value: boolean | null, set: (v: boolean | null) => void) => (
    <fieldset className={styles.tri}>
      <legend className={styles.legend}>{legend}</legend>
      <div className={styles.options}>
        {TRI.map((t) => (
          <label key={t.value} className={styles.option}>
            <input id={`filter-${name}-${t.value}`} type="radio" name={`filter-${name}`} value={t.value} checked={toTri(value) === t.value} onChange={() => set(fromTri(t.value))} />
            {t.label}
          </label>
        ))}
      </div>
    </fieldset>
  );

  return (
    <form className={styles.form} aria-label="Filters" aria-busy={busy} onSubmit={submit} noValidate>
      <div className={styles.field}>
        <label htmlFor="filter-search" className={styles.label}>
          Search
        </label>
        <input
          id="filter-search"
          className={styles.input}
          type="text"
          autoComplete="off"
          placeholder="ID, name, location or project"
          value={filter.search ?? ''}
          onChange={(e) => onChange({ search: textOf(e.target.value) })}
        />
      </div>

      <div className={styles.pair}>
        <div className={styles.field}>
          <label htmlFor="filter-country" className={styles.label}>
            Country
          </label>
          <input
            id="filter-country"
            className={styles.input}
            type="text"
            autoComplete="off"
            value={filter.country ?? ''}
            onChange={(e) => onChange({ country: textOf(e.target.value) })}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="filter-project" className={styles.label}>
            Project
          </label>
          <input
            id="filter-project"
            className={styles.input}
            type="text"
            autoComplete="off"
            list="filter-projects"
            value={filter.project ?? ''}
            onChange={(e) => onChange({ project: textOf(e.target.value) })}
          />
          <datalist id="filter-projects">
            {p.projects.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
      </div>

      <div className={styles.field}>
        <label htmlFor="filter-document" className={styles.label}>
          Document
        </label>
        <select
          id="filter-document"
          className={styles.input}
          value={filter.documentId ?? ''}
          onChange={(e) => onChange({ documentId: e.target.value || null })}
        >
          <option value="">Any document</option>
          {p.documents.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>

      <fieldset className={styles.group}>
        <legend className={styles.legend}>Final depth</legend>
        <div className={styles.pair}>
          <DepthInput field="minDepth" label="Minimum depth (m)" text={texts.minDepth} error={errors.minDepth} onText={p.onDepthText} />
          <DepthInput field="maxDepth" label="Maximum depth (m)" text={texts.maxDepth} error={errors.maxDepth} onText={p.onDepthText} />
        </div>
        {(['minDepth', 'maxDepth'] as const).map(
          (f) =>
            errors[f] && (
              <p key={f} id={`${DEPTH_ID[f]}-error`} className={styles.fieldError} role="alert">
                {errors[f]}
              </p>
            ),
        )}
        <p className={styles.hint}>A borehole whose depth is not stated never matches a depth bound.</p>
      </fieldset>

      <fieldset className={styles.group}>
        <legend className={styles.legend}>DIN 4023 codes</legend>
        <label htmlFor="filter-din-find" className={styles.sublabel}>
          Find a code
        </label>
        <input
          id="filter-din-find"
          className={styles.input}
          type="text"
          autoComplete="off"
          placeholder="Code or name, e.g. G or gravel"
          value={p.dinQuery}
          onChange={(e) => p.onDinQuery(e.target.value)}
        />
        <div className={styles.dinList}>
          {groups.map((g) => (
            <div key={g.kind} role="group" aria-labelledby={`filter-din-kind-${g.kind}`}>
              <div id={`filter-din-kind-${g.kind}`} className={styles.dinKind}>
                {g.label}
              </div>
              {g.items.map((item) => (
                <label key={item.code} className={styles.check}>
                  <input
                    type="checkbox"
                    checked={codes.includes(item.code)}
                    onChange={() => {
                      const next = toggled(codes, item.code);
                      onChange(next.length ? { dinCodes: next } : { dinCodes: [], lithologyMinDepth: null });
                    }}
                    data-din={item.code}
                  />
                  <code className={styles.code}>{item.code}</code>
                  <span>{item.name}</span>
                </label>
              ))}
            </div>
          ))}
          {!groups.length && <p className={styles.hint}>No DIN code matches “{p.dinQuery.trim()}”.</p>}
        </div>
        <div className={styles.chosen}>
          <p className={styles.hint} aria-live="polite">
            {codes.length ? `${codes.length} chosen: ${codes.map((c) => `${c} ${dinName(c)}`).join(', ')}` : 'None chosen: any lithology.'}
          </p>
          {codes.length > 0 && (
            <button type="button" className={styles.link} onClick={() => onChange({ dinCodes: [], lithologyMinDepth: null })}>
              CLEAR CODES
            </button>
          )}
        </div>
        <DepthInput
          field="lithologyMinDepth"
          label="Lithology reaches below (m)"
          text={texts.lithologyMinDepth}
          error={errors.lithologyMinDepth}
          disabled={!codes.length}
          describedBy="filter-lith-hint"
          onText={p.onDepthText}
        />
        {errors.lithologyMinDepth && (
          <p id="filter-lith-depth-error" className={styles.fieldError} role="alert">
            {errors.lithologyMinDepth}
          </p>
        )}
        <p id="filter-lith-hint" className={styles.hint}>
          {codes.length ? 'A layer with a chosen code must reach below this depth.' : 'Choose DIN codes first.'}
        </p>
      </fieldset>

      <div className={styles.pair}>
        {tri('spt', 'Has SPT', filter.hasSpt, (v) => onChange({ hasSpt: v }))}
        {tri('gw', 'Has groundwater', filter.hasGroundwater, (v) => onChange({ hasGroundwater: v }))}
      </div>

      <fieldset className={styles.group}>
        <legend className={styles.legend}>Review status</legend>
        <div className={styles.options}>
          {REVIEW.map((r) => (
            <label key={r.value} className={styles.option}>
              <input
                id={`filter-status-${r.value}`}
                type="checkbox"
                checked={filter.reviewStatus.includes(r.value)}
                onChange={() => onChange({ reviewStatus: toggled(filter.reviewStatus, r.value) })}
              />
              {r.label}
            </label>
          ))}
        </div>
        <p className={styles.hint}>None ticked: any status.</p>
      </fieldset>

      <div className={styles.inline}>
        <input
          id="filter-include-unreviewed"
          type="checkbox"
          checked={filter.includeUnreviewed}
          aria-describedby="filter-include-hint"
          onChange={() => onChange({ includeUnreviewed: !filter.includeUnreviewed })}
        />
        <label htmlFor="filter-include-unreviewed" className={styles.inlineLabel}>
          Include unreviewed boreholes
        </label>
      </div>
      <p id="filter-include-hint" className={styles.hint}>
        Off: only approved boreholes; the others are counted as left out.
      </p>

      {filter.area && (
        <div className={styles.area}>
          <span>{areaText(filter.area)}</span>
          <button type="button" className={styles.link} onClick={() => onChange({ area: null })}>
            REMOVE AREA
          </button>
        </div>
      )}

      <div className={styles.actions}>
        <button type="submit" className={styles.apply} disabled={busy} aria-describedby={p.error && !busy ? 'filter-apply-error' : undefined}>
          {busy ? 'APPLYING…' : 'APPLY'}
        </button>
        <button type="button" className={styles.reset} onClick={p.onReset}>
          RESET
        </button>
      </div>
      {p.error && !busy && (
        <p id="filter-apply-error" className={styles.fieldError}>
          {p.error}
        </p>
      )}
    </form>
  );
}

/**
 * A depth field's text, kept in step with the store's number: typing pushes the parsed value (null
 * while blank or invalid); a value set from elsewhere (RESET, a result set shown from the URL or the
 * chat) replaces the text.
 */
function useDepthText(value: number | null, push: (n: number | null) => void): [string, (text: string) => void] {
  const [text, setText] = useState(() => depthTextOf(value));
  const pushed = useRef(value);
  useEffect(() => {
    if (value === pushed.current) return;
    pushed.current = value;
    setText(depthTextOf(value));
  }, [value]);
  const change = (t: string) => {
    setText(t);
    const parsed = parseDepthText(t);
    const n = parsed === undefined ? null : parsed;
    pushed.current = n;
    if (n !== value) push(n);
  };
  return [text, change];
}

/** The section, connected to the store. `onApplied` runs after a successful APPLY. */
export function FilterPanel({ onApplied }: { onApplied?(): void }) {
  const filter = useAppStore((s) => s.filter);
  const busy = useAppStore((s) => s.resultSetBusy);
  const resultSetError = useAppStore((s) => s.resultSetError);
  const documents = useAppStore((s) => s.documents);
  const features = useAppStore((s) => s.features);
  const boreholes = useAppStore((s) => s.boreholes);
  const unplottedUids = useAppStore((s) => s.unplottedUids);
  const setFilter = useAppStore((s) => s.setFilter);
  const applyFilter = useAppStore((s) => s.applyFilter);
  const clearResultSet = useAppStore((s) => s.clearResultSet);

  const [errors, setErrors] = useState<FilterErrors>({});
  const [dinQuery, setDinQuery] = useState('');
  const [minDepth, setMin] = useDepthText(filter.minDepth, (n) => setFilter({ minDepth: n }));
  const [maxDepth, setMax] = useDepthText(filter.maxDepth, (n) => setFilter({ maxDepth: n }));
  const [lithologyMinDepth, setLithology] = useDepthText(filter.lithologyMinDepth, (n) => setFilter({ lithologyMinDepth: n }));
  const texts: DepthTexts = { minDepth, maxDepth, lithologyMinDepth };
  const setters: Record<DepthField, (t: string) => void> = { minDepth: setMin, maxDepth: setMax, lithologyMinDepth: setLithology };

  const projects = useMemo(() => {
    const off = new Set(unplottedUids);
    return knownProjects([...features.map((f) => f.project), ...boreholes.filter((b) => off.has(b.uid)).map((b) => b.project)]);
  }, [features, boreholes, unplottedUids]);
  const docs = useMemo(
    () => documents.map((d) => ({ id: d.id, name: d.name })).sort((a, b) => a.name.localeCompare(b.name)),
    [documents],
  );

  const apply = async () => {
    const found = await submitFilter(texts, useAppStore.getState().filter, { setFilter, applyFilter });
    setErrors(found);
    const first = (Object.keys(DEPTH_ID) as DepthField[]).find((f) => found[f]);
    if (first) {
      document.getElementById(DEPTH_ID[first])?.focus();
      return;
    }
    const s = useAppStore.getState();
    if (s.resultSet && !s.resultSetError) onApplied?.();
  };

  return (
    <FilterPanelView
      filter={filter}
      texts={texts}
      errors={errors}
      dinQuery={dinQuery}
      documents={docs}
      projects={projects}
      busy={busy}
      error={resultSetError}
      onChange={setFilter}
      onDepthText={(field, text) => {
        setters[field](text);
        if (errors[field] || (field === 'minDepth' && errors.maxDepth)) setErrors({});
      }}
      onDinQuery={setDinQuery}
      onApply={() => void apply()}
      onReset={() => {
        clearResultSet();
        setErrors({});
        setDinQuery('');
      }}
    />
  );
}
