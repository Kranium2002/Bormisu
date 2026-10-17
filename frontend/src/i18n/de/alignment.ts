/** German texts of the planned line (map: PLANNED LINE), keyed by the English wording (see src/i18n/index.ts). */
export const alignment: Record<string, string> = {
  'PLANNED LINE': 'GEPLANTE TRASSE',
  'Drop the line of a planned tunnel, pipeline or drilling line here: GeoJSON, KML, GPX or CSV.':
    'Die Trasse eines geplanten Tunnels, einer Leitung oder einer Bohrlinie hier ablegen: GeoJSON, KML, GPX oder CSV.',
  'CHOOSE FILE': 'DATEI WÄHLEN',
  'DRAW LINE': 'TRASSE ZEICHNEN',
  'CANCEL DRAWING': 'ZEICHNEN ABBRECHEN',
  'Planned line file': 'Datei der geplanten Trasse',
  'Click the points of the line; double-click or press Enter to finish. Esc cancels.':
    'Die Punkte der Trasse klicken; Doppelklick oder Enter schließt ab. Esc bricht ab.',
  'EPSG code of the CSV x/y columns': 'EPSG-Code der x/y-Spalten der CSV',
  'UPLOAD AGAIN': 'ERNEUT HOCHLADEN',
  'Positions are never guessed: x/y columns need the code of their coordinate system, e.g. 25832 for ETRS89 / UTM zone 32N.':
    'Positionen werden nie geraten: x/y-Spalten brauchen den Code ihres Koordinatensystems, z. B. 25832 für ETRS89 / UTM Zone 32N.',
  'Only GeoJSON, KML, GPX or CSV files can be a planned line.': 'Nur GeoJSON-, KML-, GPX- oder CSV-Dateien können eine geplante Trasse sein.',
  'The EPSG code is a number such as 25832.': 'Der EPSG-Code ist eine Zahl wie 25832.',
  'Uploading the line…': 'Trasse wird hochgeladen…',
  parts: 'Teile',
  'Distance either side (m)': 'Abstand beidseitig (m)',
  'A distance above 0 and at most 1000 m.': 'Ein Abstand über 0 und höchstens 1000 m.',
  'Finding boreholes along the line…': 'Bohrungen entlang der Trasse werden gesucht…',
  'unreviewed borehole inside the band is hidden': 'ungeprüfte Bohrung im Korridor ist ausgeblendet',
  'unreviewed boreholes inside the band are hidden': 'ungeprüfte Bohrungen im Korridor sind ausgeblendet',
  'turn on Include unreviewed': '„Ungeprüfte einbeziehen“ einschalten',
  'borehole is not on the map and cannot be checked against the line':
    'Bohrung ist nicht auf der Karte und kann nicht mit der Trasse abgeglichen werden',
  'boreholes are not on the map and cannot be checked against the line':
    'Bohrungen sind nicht auf der Karte und können nicht mit der Trasse abgeglichen werden',
  'DELETE LINE': 'TRASSE LÖSCHEN',
  'EARLIER LINES': 'FRÜHERE TRASSEN',
  SHOW: 'ZEIGEN',
  DELETE: 'LÖSCHEN',
  'No boreholes within': 'Keine Bohrungen innerhalb von',
  CHAINAGE: 'STATION',
  OFFSET: 'ABSTAND',
  SIDE: 'SEITE',
  Open: 'Öffnen',
  'DETAIL ›': 'DETAILS ›',
  Left: 'Links',
  Right: 'Rechts',
  'On the line': 'Auf der Trasse',
};
