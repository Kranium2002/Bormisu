import styles from './Chat.module.css';

interface Props {
  /** The assistant's prompt (request_area), shown as text. */
  prompt: string;
  /** A shape is being drawn now. */
  drawing: boolean;
  /** Starts drawing a rectangle (again, after Esc). */
  onDraw(): void;
  onCancel(): void;
}

/**
 * The hint over the map while the chat asks for an area (request_area, FRONTEND.md F15): the
 * assistant's prompt, how to draw, DRAW (when no shape is being drawn) and CANCEL. The area drawn
 * goes to the chat (context.map_view of the next message), not to the area selection.
 */
export function ChatAreaHint({ prompt, drawing, onDraw, onCancel }: Props) {
  return (
    <div className={styles.areaHint} role="status" data-chat-area-request="">
      <div className={styles.areaHintText}>
        <span className={styles.cardTag}>CHAT</span> {prompt}
        <span className={styles.areaHintHow}>
          {drawing
            ? 'Click two opposite corners on the map. The area goes with your next chat message. Esc stops drawing.'
            : 'Press DRAW, then click two opposite corners on the map (or pick another shape in the map tools).'}
        </span>
      </div>
      <div className={styles.areaHintActions}>
        {!drawing && (
          <button type="button" className={styles.primary} onClick={onDraw}>
            DRAW
          </button>
        )}
        <button type="button" className={styles.secondary} onClick={onCancel}>
          CANCEL
        </button>
      </div>
    </div>
  );
}
