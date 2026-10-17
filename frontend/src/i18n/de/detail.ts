/** German texts of the detail area (detail screen, profile, document view), keyed by the English wording (see src/i18n/index.ts). */
export const detail: Record<string, string> = {
  // header
  'NO BOREHOLE SELECTED': 'KEINE BOHRUNG GEWÄHLT',
  'Pick a borehole on the map or in the results table.': 'Wähle eine Bohrung auf der Karte oder in der Ergebnistabelle.',
  'OPEN MAP': 'KARTE ÖFFNEN',
  Map: 'Karte',
  'Unnamed project': 'Projekt ohne Namen',
  fictional: 'fiktiv',

  // metadata
  'Borehole name': 'Bohrungsname',
  Location: 'Ort',
  Country: 'Land',
  'Project ID': 'Projektnummer',
  Client: 'Auftraggeber',
  Contractor: 'Bohrfirma',
  'Final depth': 'Endteufe',
  'Borehole length': 'Bohrlänge',
  Inclination: 'Neigung',
  'Rock head': 'Felsoberkante',
  'Surface elevation': 'Ansatzhöhe',
  'Depth origin': 'Bezugsebene der Tiefen',
  'X / Y': 'X / Y',
  CRS: 'Koordinatensystem',
  'Drilling date': 'Bohrdatum',
  'Start date': 'Beginn',
  'End date': 'Ende',
  'Drilling method': 'Bohrverfahren',
  Casing: 'Verrohrung',
  Remarks: 'Bemerkungen',
  'not in source': 'nicht in der Quelle',
  illegible: 'unleserlich',
  'No usable coordinates': 'Keine verwertbaren Koordinaten',
  'Show source': 'Quelle zeigen',

  // layers
  '#': 'Nr.',
  'FROM–TO M': 'VON–BIS M',
  'DIN 4023': 'DIN 4023',
  'STRAT.': 'STRAT.',
  SPT: 'SPT',
  'TCR %': 'KERNGEWINN %',
  'RQD %': 'RQD %',
  'AS PRINTED': 'WIE GEDRUCKT',
  CONSISTENCY: 'KONSISTENZ',
  MOISTURE: 'FEUCHTE',
  WEATHERING: 'VERWITTERUNG',
  COLOUR: 'FARBE',
  CORED: 'GEKERNT',
  'SOIL UNIT': 'HOMOGENBEREICH',
  'GEOLOGIC AGE': 'GEOLOGISCHES ALTER',
  'SPT N': 'SPT N',
  'SPT INCREMENTS': 'SPT-SCHLAGZAHLEN',
  'SPT DEPTH (m)': 'SPT-TIEFE (m)',
  Layer: 'Schicht',
  Core: 'Kern',
  Properties: 'Eigenschaften',
  'No layers in source': 'Keine Schichten in der Quelle',

  // test results
  'TEST RESULTS': 'VERSUCHSERGEBNISSE',
  TYPE: 'ART',
  Tests: 'Versuche',
  'not stated': 'nicht angegeben',

  // groundwater
  'No groundwater reading in source': 'Kein Grundwasser in der Quelle',
  'depth not stated': 'Tiefe nicht angegeben',
  Strike: 'Angetroffen',
  'Rest level': 'Ruhewasserspiegel',
  Standpipe: 'Standrohr',
  Reading: 'Messung',

  // export menu
  'Project xlsx (target format)': 'Projekt-xlsx (Zielformat)',
  'Metadata, Log and Tests sheets as in the template, plus a Provenance sheet':
    'Blätter Metadata, Log und Tests wie in der Vorlage, dazu ein Blatt mit der Herkunft',
  'Tidy CSV': 'Tidy CSV',
  'One row per value, for your own tools': 'Eine Zeile pro Wert, für eigene Werkzeuge',
  'Open questions (CSV)': 'Offene Fragen (CSV)',
  'Flags, illegible values, inferred CRS, missing IDs: the client RFI list':
    'Markierungen, unleserliche Werte, abgeleitete Koordinatensysteme, fehlende IDs: die Rückfragenliste für den Auftraggeber',
  'Include unreviewed values': 'Ungeprüfte Werte einschließen',

  // profile
  'SPT refusal (click)': 'SPT-Abbruch (klicken)',

  // document view
  SOURCE: 'QUELLE',
  page: 'Seite',
  'no page': 'keine Seite',
  'Box not found: page shown': 'Fundstelle nicht markiert: Seite angezeigt',
  'Corrected value for': 'Korrigierter Wert für',
  SAVE: 'SPEICHERN',
  CONFIRM: 'BESTÄTIGEN',
  'OPEN FULL REVIEW ›': 'IN DER PRÜFUNG ÖFFNEN ›',
  'Esc to close': 'Esc schließt',
  'No source reference from the backend: this value can’t be corrected here.':
    'Keine Quellenangabe vom Server: Dieser Wert kann hier nicht korrigiert werden.',
};
