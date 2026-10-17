/** Value-key helpers: the stable keys of ExtractedValue within a borehole. */
export const K = {
  boreholeId: 'BoreholeID', project: 'ProjectName', startDate: 'StartDate', method: 'DrillingMethod',
  finalDepth: 'BoreholeDepth', elevation: 'SurfaceElevation', xy: 'XY', crs: 'CoordinateSystem',
  rockHead: 'RockHead', notes: 'Notes', gwStrike: 'GW.strike', gwRest: 'GW.rest',
  /** API groundwater readings, keyed by their index in the backend list (every reading is kept). */
  gw: (i: number) => `GW[${i}]`,
  bottom: (n: number) => `layer[${n}].bottom`, lithology: (n: number) => `layer[${n}].lithology`,
  spt: (n: number) => `layer[${n}].spt`, tcr: (n: number) => `layer[${n}].tcr`, rqd: (n: number) => `layer[${n}].rqd`,
} as const;
