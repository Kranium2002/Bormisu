import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useT } from '../i18n';
import { useAppStore } from '../store/appStore';
import styles from './Header.module.css';
import { Popover } from './Popover';

/**
 * "Your name" in the app bar: an optional name kept in this browser and stored with what you
 * confirm (a CRS, later clarification answers). Click opens a small form; Escape or a click outside closes it.
 */
export function ReviewerName() {
  const t = useT();
  const name = useAppStore((s) => s.reviewerName);
  const setName = useAppStore((s) => s.setReviewerName);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const inputId = useId();

  /** Closes the form from inside it (SAVE, Clear, Escape) and gives the focus back to the button. */
  const closeToButton = () => {
    setOpen(false);
    button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && e.target instanceof Node && !wrap.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const toggle = () => {
    setDraft(name ?? '');
    setOpen((o) => !o);
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    setName(draft);
    closeToButton();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    // Closes only this form, not the overlays behind it.
    e.stopPropagation();
    closeToButton();
  };

  return (
    <div ref={wrap} className={styles.nameWrap}>
      <button
        ref={button}
        type="button"
        className={`${styles.nameButton} ${name ? '' : styles.nameUnset}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={name ? `${t('Signed as')} ${name}: ${t('stored with your confirmations')}` : t('Set your name to store it with your confirmations')}
        onClick={toggle}
      >
        {name ?? t('YOUR NAME')}
      </button>
      {open && (
        <Popover width={300} top={50} label="Your name">
          <form className={styles.nameForm} onSubmit={save} onKeyDown={onKey}>
            <label className={styles.nameLabel} htmlFor={inputId}>
              {t('YOUR NAME')}
            </label>
            <input
              id={inputId}
              className={styles.nameInput}
              value={draft}
              autoFocus
              maxLength={120}
              placeholder="e.g. A. Reviewer"
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className={styles.nameNote}>
              {t('Optional. Kept in this browser only and stored with what you confirm. Leave empty to confirm without a name.')}
            </div>
            <div className={styles.nameActions}>
              <button type="submit" className={styles.nameSave}>
                {t('SAVE')}
              </button>
              {name && (
                <button
                  type="button"
                  className={styles.nameClear}
                  onClick={() => {
                    setName('');
                    closeToButton();
                  }}
                >
                  {t('Clear name')}
                </button>
              )}
            </div>
          </form>
        </Popover>
      )}
    </div>
  );
}
