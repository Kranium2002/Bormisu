import { useAppStore } from '../store/appStore';
import { CompletenessPanel } from './CompletenessPanel';
import styles from './SidePanel.module.css';
import { SourcePanel } from './SourcePanel';

/** Slide-over from the right with a scrim: the Source panel or the Completeness panel. Esc closes it. */
export function SidePanel() {
  const panel = useAppStore((s) => s.panel);
  const closePanel = useAppStore((s) => s.closePanel);
  if (!panel) return null;
  return (
    <>
      <div className={styles.scrim} onClick={closePanel} aria-hidden="true" />
      <aside className={styles.panel} role="dialog" aria-label={panel.kind === 'source' ? 'Source' : 'Completeness'}>
        {panel.kind === 'source' ? <SourcePanel panel={panel} /> : <CompletenessPanel documentId={panel.documentId} />}
      </aside>
    </>
  );
}
