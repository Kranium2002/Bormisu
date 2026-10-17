/** Value-key helpers: the stable keys of ExtractedValue within a borehole. */
export const K = {
  boreholeId: 'BoreholeID', boreholeName: 'BoreholeName', locationName: 'LocationName', country: 'Country',
  projectId: 'ProjectID', project: 'ProjectName', client: 'Client', contractor: 'DrillingContractor',
  drillingDate: 'DrillingDate', startDate: 'StartDate', endDate: 'EndDate', method: 'DrillingMethod',
  finalDepth: 'BoreholeDepth', boreholeLength: 'BoreholeLength', inclination: 'Inclination',
  elevation: 'SurfaceElevation', elevationDatum: 'ElevationDatum', depthOrigin: 'DepthOrigin',
  xy: 'XY', crs: 'CoordinateSystem', rockHead: 'RockHead', casing: 'Casing', notes: 'Notes',
  gwStrike: 'GW.strike', gwRest: 'GW.rest',
  /** API groundwater readings, keyed by their index in the backend list (every reading is kept). */
  gw: (i: number) => `GW[${i}]`,
  bottom: (n: number) => `layer[${n}].bottom`, lithology: (n: number) => `layer[${n}].lithology`,
  spt: (n: number) => `layer[${n}].spt`, tcr: (n: number) => `layer[${n}].tcr`, rqd: (n: number) => `layer[${n}].rqd`,
  strat: (n: number) => `layer[${n}].strat`, soilUnit: (n: number) => `layer[${n}].soilUnit`,
  age: (n: number) => `layer[${n}].age`, core: (n: number) => `layer[${n}].core`,
  colour: (n: number) => `layer[${n}].colour`, consistency: (n: number) => `layer[${n}].consistency`,
  moisture: (n: number) => `layer[${n}].moisture`, weathering: (n: number) => `layer[${n}].weathering`,
  ucs: (n: number) => `layer[${n}].ucs`,
  /** Samples and test results, by their index in the backend list. */
  sampleName: (i: number) => `sample[${i}].name`, sampleDepth: (i: number) => `sample[${i}].depth`,
  test: (i: number) => `test[${i}]`,
} as const;
