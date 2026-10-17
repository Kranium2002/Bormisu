/**
 * Content of a map pin popup (FRONTEND.md F9): borehole ID, project, final depth (or "Depth not
 * stated"), status chip, CRS warning, and DETAIL, REVIEW and SOURCE. A button that can't act is
 * disabled and the reason is printed under the buttons (and tied to the button with
 * aria-describedby). Leaflet measures popup content when it opens, so it is built synchronously as
 * DOM. Text goes in via textContent, never innerHTML: borehole IDs and project names come from
 * parsed reports and must not be able to inject markup.
 */
import chipStyles from '../../components/StatusChip.module.css';
import { statusChip } from '../../theme';
import type { PopupAction, PopupView } from './mapModel';
import styles from './MapPopup.module.css';

export interface PopupActions {
  /** DETAIL: the borehole's Detail screen. */
  onDetail(): void;
  /** REVIEW: the Review screen on this borehole. */
  onReview(): void;
  /** SOURCE: the Source panel of the final-depth value. */
  onSource(): void;
}

let popupIds = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function button(text: string, label: string, className: string, action: PopupAction, reasonId: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', className, text);
  b.type = 'button';
  b.setAttribute('aria-label', label);
  if (!action.enabled) {
    b.disabled = true;
    b.title = action.reason ?? '';
    b.setAttribute('aria-describedby', reasonId);
  }
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (action.enabled) onClick();
  });
  return b;
}

/** Builds the popup element of a pin. */
export function buildPopup(view: PopupView, actions: PopupActions): HTMLElement {
  const root = el('div', styles.popup);
  root.dataset.uid = view.uid;
  root.append(el('div', styles.id, view.id));
  if (view.project) root.append(el('div', styles.project, view.project));
  root.append(el('div', styles.depth, view.depth));

  const chipRow = el('div', styles.chipRow);
  const c = statusChip(view.status);
  const chip = el('span', `${chipStyles.chip} ${chipStyles.sm}`, c.label);
  chip.style.background = c.bg;
  chip.style.color = c.fg;
  chipRow.append(chip);
  root.append(chipRow);

  if (view.crsWarning) root.append(el('div', styles.crs, view.crsWarning));

  popupIds += 1;
  const reviewWhy = `map-popup-${popupIds}-review`;
  const sourceWhy = `map-popup-${popupIds}-source`;
  const row = el('div', styles.actions);
  row.append(
    button('DETAIL', `Open detail of ${view.id}`, `${styles.action} ${styles.primary}`, { enabled: true, reason: null }, '', actions.onDetail),
    button('REVIEW', `Review ${view.id}`, styles.action, view.review, reviewWhy, actions.onReview),
    button('SOURCE', `Source of the final depth of ${view.id}`, styles.action, view.source, sourceWhy, actions.onSource),
  );
  root.append(row);

  // The reasons, visible: a disabled button shows no tooltip to keyboard or touch users.
  const reasons: [string, string, PopupAction][] = [
    [reviewWhy, 'REVIEW', view.review],
    [sourceWhy, 'SOURCE', view.source],
  ];
  // The same reason for both (e.g. still loading) is printed once.
  if (!view.review.enabled && !view.source.enabled && view.review.reason === view.source.reason) {
    const p = el('p', styles.reason, view.review.reason ?? '');
    p.id = reviewWhy;
    root.append(p);
    // Both buttons point at the one printed reason.
    row.querySelectorAll('button[disabled]').forEach((b) => b.setAttribute('aria-describedby', reviewWhy));
  } else {
    for (const [id, name, action] of reasons) {
      if (action.enabled || !action.reason) continue;
      const p = el('p', styles.reason, `${name}: ${action.reason}`);
      p.id = id;
      root.append(p);
    }
  }
  return root;
}
