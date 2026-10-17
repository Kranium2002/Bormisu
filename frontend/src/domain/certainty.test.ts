import { expect, it } from 'vitest';
import { certaintyOf } from './certainty';

it('is sure when reviewed, corrected, or read with enough confidence', () => {
  expect(certaintyOf({ method: 'OCR', confidence: 0.5, status: 'approved' })).toEqual({ sure: true, title: 'Reviewed' });
  expect(certaintyOf({ method: 'Edited' }).sure).toBe(true);
  expect(certaintyOf({ method: 'Read', confidence: 0.95 })).toEqual({ sure: true, title: 'AI sure (95 %)' });
});

it('is unsure when the AI is unsure, guessed, a warning is open or it is flagged', () => {
  expect(certaintyOf({ method: 'OCR', confidence: 0.79 })).toEqual({ sure: false, title: 'AI unsure (79 %)' });
  expect(certaintyOf({ method: 'Guessed', confidence: 0.99 }).sure).toBe(false);
  expect(certaintyOf({ method: 'Read', confidence: 0.99, lint: { severity: 'warning', message: 'Datum unclear' } }).title).toBe('Datum unclear');
  expect(certaintyOf({ method: 'Read', confidence: 0.99, status: 'flagged', flag: 'check zone' }).title).toBe('Flagged: check zone');
});
