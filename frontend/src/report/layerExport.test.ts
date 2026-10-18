import { describe, expect, it } from 'vitest';
import { K } from '../domain/keys';
import { toCsv } from '../export/csv';
import { makeBorehole, makeLayer, makeValue } from '../test/fixtures';
import { LAYER_COLUMNS, layerRows, NOT_IN_SOURCE, reportFileName } from './layerExport';

const col = (name: (typeof LAYER_COLUMNS)[number]) => LAYER_COLUMNS.indexOf(name);

describe('layer export', () => {
  it('one row per layer with depths, elevations, DIN, stratigraphy, review state and source', () => {
    const b = makeBorehole({
      layers: [
        makeLayer({ n: 1, from: 0, to: 2.5, din: 'S', lithology: 'Sand', lithologyAsPrinted: 'Sand, kiesig', stratigraphicName: 'Holozän' }),
        makeLayer({ n: 2, from: 2.5, to: 6, din: null, dinNotation: null, lithology: '' }),
      ],
      values: [
        ...makeBorehole().values.filter((v) => ![K.lithology(1), K.bottom(1), K.lithology(2)].includes(v.key)),
        makeValue({ key: K.elevation, value: '152.40', unit: 'm' }),
        makeValue({ key: K.lithology(1), value: 'Sand', raw: 'Sand, kiesig', page: 3, status: 'approved' }),
        makeValue({ key: K.bottom(1), value: '2.50', unit: 'm', status: 'approved' }),
      ].filter((v, i, all) => all.findIndex((w) => w.key === v.key) === i),
    });
    const rows = layerRows([b], new Map([[b.uid, { chainageM: 412.55, offsetM: 3.21, side: 'left' }]]));
    expect(rows[0]).toEqual([...LAYER_COLUMNS]);
    expect(rows).toHaveLength(3);
    const [, first, second] = rows;
    expect(first[col('BoreholeID')]).toBe('TB-01');
    expect(first[col('Chainage_m')]).toBe(412.6);
    expect(first[col('Side')]).toBe('left');
    expect(first[col('GroundLevel_m')]).toBe(152.4);
    expect(first[col('DepthFrom_m')]).toBe(0);
    expect(first[col('TopElevation_m')]).toBe(152.4);
    expect(first[col('BottomElevation_m')]).toBe(149.9);
    expect(first[col('Description_AsPrinted')]).toBe('Sand, kiesig');
    expect(first[col('DIN4023')]).toBe('S');
    expect(first[col('Stratigraphy')]).toBe('Holozän');
    expect(first[col('SourceDocument')]).toBe('test_report.pdf');
    expect(first[col('Page')]).toBe(3);
    // What the source doesn't state is said so, never filled in.
    expect(second[col('DIN4023')]).toBe(NOT_IN_SOURCE);
    expect(second[col('Description_English')]).toBe(NOT_IN_SOURCE);
    expect(second[col('Stratigraphy')]).toBe(NOT_IN_SOURCE);
    expect(second[col('Reviewed')]).toBe('no');
  });

  it('without a ground level the elevations stay empty, never 0; a borehole without layers gets one row', () => {
    const empty = makeBorehole({ uid: 'bh_E', id: 'E-1', layers: [] });
    const rows = layerRows([makeBorehole(), empty]);
    const r = rows[1];
    expect(r[col('GroundLevel_m')]).toBeNull();
    expect(r[col('TopElevation_m')]).toBeNull();
    expect(r[col('Chainage_m')]).toBeNull();
    const last = rows[rows.length - 1];
    expect(last[col('BoreholeID')]).toBe('E-1');
    expect(last[col('Description_AsPrinted')]).toBe('no layers in source');
    expect(last[col('DepthFrom_m')]).toBeNull();
    expect(toCsv(rows).split('\n')[0]).toContain('"DIN4023"');
  });

  it('file names come from the selection title', () => {
    expect(reportFileName('Planned line: Trasse Nord', 'layers', 'csv')).toBe('Planned_line_Trasse_Nord_layers.csv');
    expect(reportFileName('', 'layers', 'xlsx')).toBe('selection_layers.xlsx');
    expect(reportFileName('Area: Rectangle, 19.46 km²', 'layers', 'csv')).toBe('Area_Rectangle_19_46_km2_layers.csv');
    expect(reportFileName('Geplante Trasse: Süd', 'layers', 'csv')).toBe('Geplante_Trasse_Sud_layers.csv');
  });
});
