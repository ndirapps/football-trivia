import { useState } from "react";
import { declineReminder, enableReminder, shouldOfferReminder } from "../lib/reminders";
import { sound } from "../lib/sound";
import { Icon } from "./Icon";
import "./ReminderOffer.css";

/**
 * "Want a reminder for the daily challenge?" — asked once, in the app, under a
 * finished quiz. A card rather than a dialog: it can be ignored, and nothing
 * happens until the player taps yes, when iOS asks its own permission.
 */
export function ReminderOffer() {
  const [visible, setVisible] = useState(shouldOfferReminder);
  const [done, setDone] = useState<"on" | "off" | null>(null);

  if (!visible) return null;

  if (done) {
    return (
      <p className="reminder-done" role="status">
        {done === "on" ? "מעולה, נזכיר לכם כל יום ב-19:00." : "בסדר, בלי תזכורות."}
      </p>
    );
  }

  return (
    <section className="reminder" aria-label="תזכורת יומית">
      <span className="reminder-icon" aria-hidden="true">
        <Icon name="calendar" size={20} />
      </span>
      <div className="reminder-text">
        <p className="reminder-title">תזכורת לאתגר היומי?</p>
        <p className="reminder-sub">כל יום ב-19:00, עשר שאלות חדשות.</p>
      </div>
      <div className="reminder-actions">
        <button
          className="btn btn-primary btn-sm"
          onClick={async () => {
            sound.play("select");
            const on = await enableReminder().catch(() => false);
            setDone(on ? "on" : "off");
          }}
        >
          כן
        </button>
        <button
          className="btn btn-quiet btn-sm"
          onClick={() => {
            declineReminder();
            setVisible(false);
          }}
        >
          לא תודה
        </button>
      </div>
    </section>
  );
}
