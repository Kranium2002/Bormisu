import { useRef } from 'react';
import { useAppStore, type PanelState } from '../store/appStore';
import { CompletenessPanel } from './CompletenessPanel';
import styles from './SidePanel.module.css';
import { SourcePanel } from './SourcePanel';
import { useDialogFocus } from './useDialogFocus';

/** Slide-over from the right with a scrim: the Source panel or the Completeness panel. Esc closes it. */
export function SidePanel() {
  const panel = useAppStore((s) => s.panel);
  if (!panel) return null;
  return <PanelDialog panel={panel} />;
}

/** The open panel: modal, so Tab stays inside it; focus returns to the opener when it closes. */
function PanelDialog({ panel }: { panel: NonNullable<PanelState> }) {
  const closePanel = useAppStore((s) => s.closePanel);
  const ref = useRef<HTMLElement>(null);
  useDialogFocus(ref, { trap: true });
  return (
    <>
      <div className={styles.scrim} onClick={closePanel} aria-hidden="true" />
      <aside
        ref={ref}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={panel.kind === 'source' ? 'Source' : 'Completeness'}
      >
        {panel.kind === 'source' ? <SourcePanel panel={panel} /> : <CompletenessPanel documentId={panel.documentId} />}
      </aside>
    </>
  );
}
