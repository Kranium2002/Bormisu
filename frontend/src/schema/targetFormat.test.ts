import { describe, expect, it } from 'vitest';
import { MULTI_FIELD_SEPARATOR, multiField, REGULATION, section, SECTIONS } from './targetFormat';

describe('target format', () => {
  it('has the template sections in order with 14 / 12 / 19 fields', () => {
    expect(SECTIONS.map((s) => s.title)).toEqual(['Metadata', 'Logdata', 'Test Results']);
    expect(section('metadata').fields).toHaveLength(14);
    expect(section('logdata').fields).toHaveLength(12);
    expect(section('testResults').fields).toHaveLength(19);
    expect(REGULATION).toBe('DIN 4023');
  });

  it('keeps the template field order and spelling', () => {
    const meta = section('metadata').fields.map((f) => f.name);
    expect(meta[0]).toBe('BoreholeID');
    expect(meta[7]).toBe('Surface Elevation');
    expect(meta[13]).toBe('Notes');
    const tests = section('testResults').fields;
    expect(tests[1]).toMatchObject({ name: 'Cosistency', note: 'sic, Consistency' });
    expect(tests[18].name).toBe('PoissonsRatio');
  });

  it('gives every field a unit, and field names are unique', () => {
    const all = SECTIONS.flatMap((s) => s.fields);
    expect(all.every((f) => f.unit.length > 0)).toBe(true);
    expect(new Set(all.map((f) => f.name)).size).toBe(all.length);
  });

  it('only the test results section is optional', () => {
    expect(SECTIONS.filter((s) => s.optional).map((s) => s.id)).toEqual(['testResults']);
  });

  it('joins multi-field names with the shared separator', () => {
    expect(multiField('X-Coordinate', 'Y-Coordinate')).toBe(['X-Coordinate', 'Y-Coordinate'].join(MULTI_FIELD_SEPARATOR));
  });
});
