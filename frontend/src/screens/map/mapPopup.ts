/**
 * Content of a map pin popup (prototype popupHtml): ID, project, final depth, status chip,
 * CRS warning and OPEN DETAIL ›. Leaflet measures popup content when it opens, so the content is
 * built synchronously as DOM. Text goes in via textContent, never innerHTML: borehole IDs and
 * project names come from parsed reports and must not be able to inject markup.
 */
import chipStyles from '../../components/StatusChip.module.css';
import type { BoreholeStatus } from '../../domain/types';
import { statusChip } from '../../theme';
import styles from './MapPopup.module.css';

export interface PopupData {
  id: string;
  project: string;
  depth: string;
  status: BoreholeStatus;
  crsWarning: string | null;
}

function div(className: string | undefined, text?: string): HTMLDivElement {
  const el = document.createElement('div');
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

/** Builds the popup element; `onOpen` runs when OPEN DETAIL › is clicked. */
export function buildPopup(data: PopupData, onOpen: () => void): HTMLElement {
  const root = div(styles.popup);
  root.append(div(styles.id, data.id), div(undefined, data.project), div(undefined, `Final depth ${data.depth}`));

  const chipRow = div(styles.chipRow);
  const c = statusChip(data.status);
  const chip = document.createElement('span');
  chip.className = `${chipStyles.chip} ${chipStyles.sm}`;
  chip.style.background = c.bg;
  chip.style.color = c.fg;
  chip.textContent = c.label;
  chipRow.append(chip);
  root.append(chipRow);

  if (data.crsWarning) root.append(div(styles.crs, data.crsWarning));

  const button = document.createElement('button');
  button.type = 'button';
  button.className = styles.open;
  button.textContent = 'OPEN DETAIL ›';
  button.setAttribute('aria-label', `Open detail of ${data.id}`);
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    onOpen();
  });
  root.append(button);
  return root;
}
