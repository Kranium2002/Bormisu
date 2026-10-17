/**
 * PLACE SEARCH section of the explore panel (FRONTEND.md F11, LGRB "Ortssuche"): a text field and
 * SEARCH, which asks GET /geocode on submit only (Enter or the button; never as you type). One
 * candidate flies there (the store does it); several are listed in the server's order (uploaded
 * places first) and a click flies to one. A place without uploaded boreholes says so next to it (the
 * map outlines it dashed). "No place found" and "Place search unavailable" are in the status line.
 * The header's search stays for borehole IDs and projects.
 */
import { useState, type FormEvent } from 'react';
import type { PlaceCandidate } from '../../../domain/types';
import { useT } from '../../../i18n';
import { useAppStore } from '../../../store/appStore';
import styles from './PlaceSearch.module.css';
import { chosenAfterSearch, noUploadedBoreholes, placeCountText, placeKindText, placeStatusText } from './placeModel';

/** The API needs at least two characters (contract GET /geocode, q minLength 2). */
const MIN_QUERY = 2;
export const QUERY_TOO_SHORT = 'Type at least two characters.';
export const NO_GEOCODER_HINT = 'Only places named in uploaded reports are found: the server has no geocoder.';

export interface PlaceSearchViewProps {
  text: string;
  onTextChange(text: string): void;
  onSubmit(): void;
  onChoose(index: number): void;
  busy: boolean;
  /** The store's error, or a local one (query too short). */
  error: string | null;
  places: PlaceCandidate[] | null;
  /** The candidate flown to, or null. */
  chosen: number | null;
  /** Per candidate: true when it holds no uploaded borehole. */
  empty: boolean[];
  /** Shown under the field (e.g. the server has no geocoder), or null. */
  hint: string | null;
}

/** The section's content, from props (server-rendered in tests). */
export function PlaceSearchView({ text, onTextChange, onSubmit, onChoose, busy, error, places, chosen, empty, hint }: PlaceSearchViewProps) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  const t = useT();
  const status = placeStatusText({ busy, error, places });
  return (
    <div className={styles.root}>
      <form role="search" aria-label="Place search" className={styles.form} onSubmit={submit} noValidate>
        <label htmlFor="place-query" className={styles.label}>
          {t('Town, address or place')}
        </label>
        <div className={styles.row}>
          <input
            id="place-query"
            className={styles.input}
            type="text"
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={hint ? 'place-hint' : undefined}
          />
          <button type="submit" className={styles.submit} disabled={busy} title={busy ? t('Searching…') : undefined}>
            {t('SEARCH')}
          </button>
        </div>
        {hint && (
          <p id="place-hint" className={styles.hint}>
            {t(hint)}
          </p>
        )}
      </form>
      <div className={styles.results} aria-busy={busy}>
        <p className={`${styles.status} ${error ? styles.error : ''}`} role="status">
          {t(status)}
        </p>
        {!!places?.length && (
          <ul className={styles.list} aria-label="Places found">
            {places.map((c, i) => {
              const picked = chosen === i;
              const none = picked && empty[i];
              const kind = placeKindText(c.kind);
              const count = placeCountText(c);
              return (
                <li key={`${i}:${c.label}`} className={styles.item}>
                  <button
                    type="button"
                    className={`${styles.place} ${picked ? styles.picked : ''}`}
                    aria-pressed={picked}
                    aria-describedby={none ? `place-none-${i}` : undefined}
                    data-place={i}
                    onClick={() => onChoose(i)}
                  >
                    <span className={styles.placeLabel}>{c.label}</span>
                    <span className={styles.meta}>
                      {kind && <span>{kind}</span>}
                      <span className={`${styles.source} ${c.source === 'uploaded' ? styles.uploaded : styles.geocoder}`}>{c.source}</span>
                      {count && <span>{count}</span>}
                    </span>
                  </button>
                  {none && (
                    <p id={`place-none-${i}`} className={styles.none}>
                      {t('No uploaded boreholes here')}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * The section, connected to the store. `onFlown` runs when the map flies to a place (one candidate,
 * or a chosen one): on a narrow screen the panel then gets out of the map's way.
 */
export function PlaceSearch({ onFlown }: { onFlown?(): void }) {
  const placeQuery = useAppStore((s) => s.placeQuery);
  const places = useAppStore((s) => s.places);
  const busy = useAppStore((s) => s.placeBusy);
  const storeError = useAppStore((s) => s.placeError);
  const features = useAppStore((s) => s.features);
  const health = useAppStore((s) => s.health);
  const searchPlace = useAppStore((s) => s.searchPlace);
  const choosePlace = useAppStore((s) => s.choosePlace);

  const [text, setText] = useState(placeQuery);
  const [localError, setLocalError] = useState<string | null>(null);
  // A new answer chooses its only candidate (the store flew there); several wait for a click.
  const [answer, setAnswer] = useState(places);
  const [chosen, setChosen] = useState<number | null>(() => chosenAfterSearch(places));
  if (answer !== places) {
    setAnswer(places);
    setChosen(chosenAfterSearch(places));
  }

  const submit = () => {
    const q = text.trim();
    if (q.length < MIN_QUERY) {
      setLocalError(QUERY_TOO_SHORT);
      return;
    }
    setLocalError(null);
    void searchPlace(q).then(() => {
      const s = useAppStore.getState();
      if (s.placeQuery === q && !s.placeError && s.places?.length === 1) onFlown?.();
    });
  };

  const choose = (i: number) => {
    setChosen(i);
    choosePlace(i);
    onFlown?.();
  };

  const empty = (places ?? []).map((c) => noUploadedBoreholes(c, features));
  const hint = health && health.mode !== 'sample' && !health.providers.geocoder ? NO_GEOCODER_HINT : null;
  return (
    <PlaceSearchView
      text={text}
      onTextChange={(t) => {
        setText(t);
        if (localError) setLocalError(null);
      }}
      onSubmit={submit}
      onChoose={choose}
      busy={busy}
      error={localError ?? storeError}
      places={localError ? null : places}
      chosen={chosen}
      empty={empty}
      hint={hint}
    />
  );
}
