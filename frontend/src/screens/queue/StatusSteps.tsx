import type { DocumentStep } from '../../domain/types';
import { stepViews, type StepState } from './queueView';
import styles from './StatusSteps.module.css';

const STATE_TEXT: Record<StepState, string> = {
  done: 'done',
  active: 'in progress',
  review: 'waiting for review',
  failed: 'failed',
  pending: 'not started',
};

interface Props {
  step: DocumentStep;
  failed: boolean;
  /** The failed stage in words (e.g. "text recognition (OCR)"), named on the failed step; '' when unknown. */
  failedStage?: string;
}

/** The four processing steps of a document; the running one pulses, "needs review" is amber, a failed one red. */
export function StatusSteps({ step, failed, failedStage = '' }: Props) {
  const views = stepViews(step, failed);
  return (
    <ol className={styles.steps} aria-label="Processing status">
      {views.map((s, i) => (
        <li
          key={s.label}
          className={`${styles.step} ${styles[s.state]}`}
          aria-current={s.state === 'active' || s.state === 'review' || s.state === 'failed' ? 'step' : undefined}
          title={`${s.label}: ${STATE_TEXT[s.state]}${s.state === 'failed' && failedStage ? ` at ${failedStage}` : ''}`}
        >
          <span className={`${styles.dot} ${s.pulse ? styles.pulse : ''}`} aria-hidden="true" />
          {s.label}
          {i < views.length - 1 && <span className={styles.conn} aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}
