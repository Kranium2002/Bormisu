import { expect, it } from 'vitest';
import { certaintyOf } from './certainty';

it('is sure (✓) when reviewed, corrected, or read with enough confidence', () => {
  expect(certaintyOf({ method: 'OCR', confidence: 0.5, status: 'approved' })).toEqual({ kind: 'sure', title: 'Reviewed' });
  expect(certaintyOf({ method: 'Edited' }).kind).toBe('sure');
  expect(certaintyOf({ method: 'Read', confidence: 0.95 })).toEqual({ kind: 'sure', title: 'AI sure (95 %)' });
});

it('is unsure (?) when the AI is unsure, guessed or a warning is open', () => {
  expect(certaintyOf({ method: 'OCR', confidence: 0.79 })).toEqual({ kind: 'unsure', title: 'AI unsure (79 %)' });
  expect(certaintyOf({ method: 'Guessed', confidence: 0.99 }).kind).toBe('unsure');
  expect(certaintyOf({ method: 'Read', confidence: 0.99, lint: { severity: 'warning', message: 'Datum unclear' } })).toEqual({ kind: 'unsure', title: 'Datum unclear' });
});

it('shows a flag (!) first, and a value the source does not state as missing (–)', () => {
  expect(certaintyOf({ method: 'Read', confidence: 0.99, status: 'flagged', flag: 'check zone', state: 'illegible' }))
    .toEqual({ kind: 'flagged', title: 'Flagged: check zone' });
  expect(certaintyOf({ method: 'Read', confidence: 0.99, state: 'not in source' })).toEqual({ kind: 'missing', title: 'Not in the source' });
  expect(certaintyOf({ method: 'Read', state: 'illegible', status: 'approved' })).toEqual({ kind: 'missing', title: 'Illegible in the source (reviewed)' });
});
