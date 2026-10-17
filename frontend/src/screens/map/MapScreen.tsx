/**
 * Map screen (prototype template lines 48–79): Leaflet map with status-coloured pins, the MAP FOCUS
 * dropdown and the REVIEW STATUS legend, the NOT ON MAP aside, and the RESULTS table underneath.
 *
 * The map focus (store `mapFocus`, src/geo/mapFocus.ts) is World or one country. In a country view
 * only that country's boreholes are pins, the legend counts them, RESULTS lists them (plus the
 * boreholes without coordinates), and the boreholes elsewhere are one line under NOT ON MAP and under
 * RESULTS, each with SHOW WORLD. A search result in another country switches the focus to that
 * country (World when it lies in none) and then flies there. A search result without usable
 * coordinates is highlighted under NOT ON MAP while its message shows, and an open popup closes.
 *
 * MY LOCATION (under the zoom buttons) asks the browser for the position, switches the focus to the
 * country it lies in, flies there and opens NEAR YOU with the five nearest boreholes. The position
 * stays in memory (store `myLocation`): never sent, saved or put in the URL. Sample mode only: a
 * "Simulate: Neckarbogen site" option and `?simLocation=lat,lng` stand in for a real position.
 */
import { useEffect, useMemo, useState } from 'react';
import { countryLocator } from '../../geo/countryAssign';
import { parseLatLng } from '../../geo/geolocate';
import { WORLD } from '../../geo/mapFocus';
import { boxOf, unionBox } from '../../geo/polygon';
import { useAppStore } from '../../store/appStore';
import { BoreholeMap, type MapView, type MeMarker } from './BoreholeMap';
import { FocusSelect } from './FocusSelect';
import { MapLegend } from './MapLegend';
import {
  focusName,
  focusOptions,
  isPlotted,
  legendEntries,
  nearYouModel,
  notOnMapSearchTarget,
  outsideSummary,
  placeBoreholes,
  searchStep,
  statusByUid,
} from './mapModel';
import styles from './MapScreen.module.css';
import { MyLocationControl } from './MyLocationControl';
import { NearYouPanel } from './NearYouPanel';
import { NotOnMapList } from './NotOnMapList';
import { ResultsTable } from './ResultsTable';
import { useCountries } from './useCountries';

/** The last search target whose focus switch / message is done (the screen unmounts on navigation). */
let settledSearchNonce: number | null = null;
/** The last MY LOCATION fix whose focus switch is done. */
let settledLocationNonce: number | null = null;
/** `?simLocation=` is applied once per page load. */
let simParamRead = false;
/** Half the NEAR YOU panel's width: the position lands in the middle of the map area left of it. */
const NEAR_YOU_OFFSET_PX = 180;

export function MapScreen() {
  const boreholes = useAppStore((s) => s.boreholes);
  const reviewUid = useAppStore((s) => s.reviewUid);
  const flyTarget = useAppStore((s) => s.flyTarget);
  const searchMessage = useAppStore((s) => s.searchMessage);
  const focus = useAppStore((s) => s.mapFocus);
  const setMapFocus = useAppStore((s) => s.setMapFocus);
  const openBorehole = useAppStore((s) => s.openBorehole);
  const showNotOnMap = useAppStore((s) => s.showNotOnMap);
  const source = useAppStore((s) => s.source);
  const myLocation = useAppStore((s) => s.myLocation);
  const nearYouOpen = useAppStore((s) => s.nearYouOpen);
  const locateMe = useAppStore((s) => s.locateMe);
  const simulateLocation = useAppStore((s) => s.simulateLocation);
  const closeNearYou = useAppStore((s) => s.closeNearYou);

  const { countries, error } = useCountries();
  const statuses = useMemo(() => statusByUid(boreholes), [boreholes]);
  const pins = useMemo(() => boreholes.filter(isPlotted), [boreholes]);
  const hits = useMemo(() => (countries ? countryLocator(countries).assign(pins) : null), [countries, pins]);
  const country = useMemo(() => countries?.find((c) => c.code === focus) ?? null, [countries, focus]);
  // The map shows the world when the outlines failed to load or the code is no known country.
  const effective = focus !== WORLD && (error || (countries && !country)) ? WORLD : focus;
  const pending = effective !== WORLD && !country;
  const label = focusName(effective, country);

  const placement = useMemo(() => placeBoreholes(boreholes, effective, hits), [boreholes, effective, hits]);
  const legend = useMemo(() => legendEntries(placement.plotted, statuses), [placement, statuses]);
  const options = useMemo(() => focusOptions(focus, pins.length, countries, hits), [focus, pins, countries, hits]);
  const outside = pending ? null : outsideSummary(placement.outside, hits, label, countries);

  const view = useMemo<MapView>(() => {
    if (effective === WORLD) return { kind: 'world', key: WORLD, pins: boxOf(pins) };
    if (!country) return { kind: 'pending', key: effective };
    // The country's main territory, grown to every pin in it (e.g. a borehole on an outlying island).
    const pinBox = boxOf(placement.plotted);
    return { kind: 'country', key: country.code, country, box: pinBox ? unionBox(country.view, pinBox) : country.view };
  }, [effective, country, pins, placement.plotted]);

  // An unknown code (e.g. ?focus=ZZ) falls back to World once the outlines are loaded.
  useEffect(() => {
    if (countries && focus !== WORLD && !country) setMapFocus(WORLD);
  }, [countries, focus, country, setMapFocus]);

  // A search result: fly when it is a pin of this focus, else switch the focus first (once per search).
  const target = flyTarget ? boreholes.find((b) => b.uid === flyTarget.uid) : undefined;
  const step = target ? searchStep(target, placement, pending ? null : hits) : null;
  useEffect(() => {
    if (!flyTarget || !target || !step || step.kind === 'wait' || flyTarget.nonce === settledSearchNonce) return;
    settledSearchNonce = flyTarget.nonce;
    if (step.kind === 'switch') setMapFocus(step.focus);
    else if (step.kind === 'missing') showNotOnMap(target.id, step.reason);
  }, [flyTarget, target, step, setMapFocus, showNotOnMap]);
  const fly = step?.kind === 'fly' ? flyTarget : null;

  // A search result listed under NOT ON MAP (while its message shows): highlight it there and close
  // the popup of an earlier result.
  const notOnMapUid = notOnMapSearchTarget(searchMessage, placement.unplaced, step?.kind === 'missing' && target ? target.uid : null);
  const [closePopupNonce, setClosePopupNonce] = useState(0);
  useEffect(() => {
    if (notOnMapUid) setClosePopupNonce((n) => n + 1);
  }, [notOnMapUid, searchMessage]);

  // MY LOCATION. Sample mode only: the demo site and ?simLocation=lat,lng (read once per page load).
  const site = source?.kind === 'sample' ? (source.simulatedSite ?? null) : null;
  useEffect(() => {
    if (!site || simParamRead) return;
    simParamRead = true;
    const at = parseLatLng(new URLSearchParams(window.location.search).get('simLocation'));
    if (at) simulateLocation(at.lat, at.lng);
  }, [site, simulateLocation]);
  const located = myLocation.status === 'located' ? myLocation : null;
  const me = useMemo<MeMarker | null>(
    () => (located ? { lat: located.lat, lng: located.lng, accuracyM: located.accuracyM, simulated: located.simulated, nonce: located.nonce } : null),
    [located],
  );
  const meHit = located && countries ? countryLocator(countries).locate(located.lat, located.lng) : null;
  // The focus for the position: its country, World when it lies in none (or without outlines).
  const meFocus = !located ? null : countries ? (meHit?.country ?? WORLD) : error ? WORLD : null;
  useEffect(() => {
    if (!located || meFocus === null || located.nonce === settledLocationNonce) return;
    settledLocationNonce = located.nonce;
    if (focus !== meFocus) setMapFocus(meFocus);
  }, [located, meFocus, focus, setMapFocus]);
  const flyToMe = meFocus !== null && effective === meFocus && !pending;
  const nearYou = useMemo(() => (located && nearYouOpen ? nearYouModel(located, pins) : null), [located, nearYouOpen, pins]);

  const showWorld = () => setMapFocus(WORLD);
  const note = error ? 'Country outlines unavailable: World only' : !countries ? 'Loading countries…' : null;

  return (
    <div className={styles.screen} data-screen-label="Map">
      <div className={styles.mapCell}>
        <BoreholeMap
          boreholes={placement.plotted}
          statuses={statuses}
          highlightUid={reviewUid}
          view={view}
          fly={fly}
          closePopupNonce={closePopupNonce}
          me={me}
          flyToMe={flyToMe}
          meOffsetPx={nearYouOpen ? NEAR_YOU_OFFSET_PX : 0}
          locateControl={
            <MyLocationControl
              state={myLocation}
              onLocate={() => void locateMe()}
              simulateLabel={site?.label ?? null}
              onSimulate={() => site && simulateLocation(site.lat, site.lng)}
            />
          }
          onOpen={openBorehole}
        />
        <FocusSelect value={focus} options={options} onChange={setMapFocus} note={note} />
        <MapLegend entries={legend} />
        {nearYou && located && (
          <NearYouPanel model={nearYou} simulated={located.simulated} statuses={statuses} onOpen={openBorehole} onClose={closeNearYou} />
        )}
      </div>
      <NotOnMapList
        items={placement.unplaced}
        outside={outside}
        focusLabel={label}
        activeUid={notOnMapUid}
        onOpen={openBorehole}
        onShowWorld={showWorld}
      />
      <ResultsTable
        boreholes={pending ? [] : placement.results}
        statuses={statuses}
        focusLabel={label}
        anyBoreholes={boreholes.length > 0}
        loading={pending}
        outside={outside}
        onOpen={openBorehole}
        onShowWorld={showWorld}
      />
    </div>
  );
}
