import type { ReactNode } from 'react';
import { useAppStore } from '../store/appStore';
import styles from './SidePanel.module.css';

/** Panel header with a title block and the × close button. */
export function PanelHeader({ children }: { children: ReactNode }) {
  const closePanel = useAppStore((s) => s.closePanel);
  return (
    <div className={styles.head}>
      <div className={styles.headText}>{children}</div>
      <button type="button" className={styles.close} onClick={closePanel} aria-label="Close panel">
        ×
      </button>
    </div>
  );
}
