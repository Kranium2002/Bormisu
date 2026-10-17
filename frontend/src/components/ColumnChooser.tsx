import { useRef, useState } from 'react';
import { useT } from '../i18n';
import styles from './ColumnChooser.module.css';

/** A column the user can add or remove; `group` puts it under a heading in the + menu. */
export interface ChoosableColumn { key: string; label: string; group?: string; title?: string }

/**
 * The optional columns a table shows, remembered in this browser under `storageKey` (a convenience: it
 * falls back to `defaults` when storage is blocked or holds nothing valid).
 */
export function useColumns(storageKey: string, defaults: string[], valid: (key: string) => boolean): [string[], (keys: string[]) => void] {
  const [keys, setKeys] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      if (Array.isArray(saved)) return saved.filter((k): k is string => typeof k === 'string' && valid(k));
    } catch {
      // no storage (private window, blocked site data): the defaults
    }
    return defaults;
  });
  const save = (next: string[]) => {
    setKeys(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // not remembered, still shown
    }
  };
  return [keys, save];
}

/** Header cell of an optional column: its name and × to remove it. */
export function RemovableHeader({ label, title, onRemove, className }: { label: string; title?: string; onRemove(): void; className?: string }) {
  const t = useT();
  return (
    <div className={`${className ?? ''} ${styles.head}`} role="columnheader" title={title}>
      {t(label)}
      <button type="button" className={styles.remove} aria-label={`Remove column ${label}`} onClick={onRemove}>×</button>
    </div>
  );
}

/** + at the end of a header row: a menu of the hidden columns, under their group headings. */
export function AddColumnMenu({ hidden, onAdd }: { hidden: readonly ChoosableColumn[]; onAdd(key: string): void }) {
  const t = useT();
  const menu = useRef<HTMLDetailsElement>(null);
  // The list is fixed to the screen at the + button, so a sideways-scrolling table can't clip it.
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  if (!hidden.length) return null;
  const onToggle = () => {
    const d = menu.current;
    if (!d?.open) return setAt(null);
    const r = d.querySelector('summary')!.getBoundingClientRect();
    setAt({ top: r.bottom + 4, right: window.innerWidth - r.right });
  };
  const groups = [...new Set(hidden.map((c) => c.group ?? ''))];
  const add = (key: string) => {
    onAdd(key);
    if (menu.current) menu.current.open = false;
  };
  return (
    <details ref={menu} className={styles.menu} onToggle={onToggle}>
      <summary className={styles.plus} aria-label={t('Add a column')} title={t('Add a column')}>+</summary>
      <ul className={styles.list} style={at ?? undefined}>
        {groups.map((g) => (
          <li key={g}>
            {g && <div className={styles.group}>{t(g)}</div>}
            <ul className={styles.groupList}>
              {hidden.filter((c) => (c.group ?? '') === g).map((c) => (
                <li key={c.key}>
                  <button type="button" className={styles.item} title={c.title} onClick={() => add(c.key)}>{t(c.label)}</button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </details>
  );
}
