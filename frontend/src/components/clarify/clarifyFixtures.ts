/**
 * Test helpers of the clarification UI: fictional questions and form fields in the domain shape.
 * Used by the unit tests only (not by the app).
 */
import type { Clarification, CrsCandidate, Evidence, FormField } from '../../domain/types';

export const DOC = 'doc_01TESTFICTIONAL000000000A';
export const DOC_B = 'doc_01TESTFICTIONAL000000000B';
export const UID = 'bh_01TESTFICTIONAL0000000001';
export const UID_B = 'bh_01TESTFICTIONAL0000000002';

/** A form field; `default` stays absent unless given (the server sent none). */
export function makeField(o: Partial<FormField> & Pick<FormField, 'name' | 'widget'>): FormField {
  return { label: o.name, help: null, required: false, unitOptions: [], options: [], default: undefined, ...o };
}

export function makeEvidence(o: Partial<Evidence> = {}): Evidence {
  return { documentId: DOC, page: 2, box: { x: 0.1, y: 0.2, w: 0.3, h: 0.05 }, snippet: 'fictional snippet', ...o };
}

export function makeClarification(o: Partial<Clarification> = {}): Clarification {
  return {
    id: 'cl_01TESTFICTIONAL0000000001',
    kind: 'unit_ambiguous',
    status: 'open',
    documentId: DOC,
    boreholeUids: [UID],
    path: null,
    question: 'Which unit is the fictional value printed in?',
    fields: [makeField({ name: 'value', widget: 'number_unit', label: 'Value', required: true, unitOptions: ['kN/m3', 't/m3'] })],
    evidence: [makeEvidence()],
    answer: null,
    answeredBy: null,
    createdAt: '2026-10-17T07:33:15Z',
    resolvedAt: null,
    ...o,
  };
}

export function makeCandidate(o: Partial<CrsCandidate> & Pick<CrsCandidate, 'code'>): CrsCandidate {
  return {
    name: `Fictional system ${o.code}`,
    note: null,
    score: null,
    verdict: null,
    swapAxes: false,
    points: [{ uid: UID, lat: 10.5, lng: 20.25 }],
    ...o,
  };
}
