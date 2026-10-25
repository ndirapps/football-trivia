// The daily-challenge reminder, in the app.
//
// A local notification, scheduled on the phone itself: every day at 19:00, "the
// daily challenge is waiting". No server, no push certificates, nothing sent
// anywhere — the phone reminds itself. Offered once, after a finished quiz, and
// only ever after the player taps "yes"; iOS then asks its own permission.
// Tapping the notification opens the daily challenge.

import { safeLocal } from "./safeStorage";

export const REMINDER_KEY = "fiq_daily_reminder";
const NOTIFICATION_ID = 1001;
const REMINDER_HOUR = 19;

type LocalNotificationsModule = typeof import("@capacitor/local-notifications");
let loaded: Promise<LocalNotificationsModule> | null = null;
const plugin = () => (loaded ??= import("@capacitor/local-notifications"));

function isNativeApp(): boolean {
  const capacitor = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return capacitor?.isNativePlatform?.() === true;
}

/** True when the offer should be shown: the app, and never answered before. */
export function shouldOfferReminder(): boolean {
  return isNativeApp() && safeLocal.get(REMINDER_KEY) === null;
}

export function declineReminder(): void {
  safeLocal.set(REMINDER_KEY, "off");
}

/** Asks iOS, and schedules the daily reminder if allowed. Resolves to whether it is on. */
export async function enableReminder(): Promise<boolean> {
  const { LocalNotifications } = await plugin();
  const permission = await LocalNotifications.requestPermissions();
  if (permission.display !== "granted") {
    safeLocal.set(REMINDER_KEY, "off");
    return false;
  }
  await LocalNotifications.cancel({ notifications: [{ id: NOTIFICATION_ID }] });
  await LocalNotifications.schedule({
    notifications: [
      {
        id: NOTIFICATION_ID,
        title: "האתגר היומי מחכה",
        body: "עשר שאלות חדשות. מה ה-Football IQ שלכם היום?",
        schedule: { on: { hour: REMINDER_HOUR, minute: 0 }, allowWhileIdle: true },
        extra: { route: "/daily" },
      },
    ],
  });
  safeLocal.set(REMINDER_KEY, "on");
  return true;
}

/** Opens the daily challenge when the reminder is tapped. Returns an unsubscribe. */
export function listenForReminderTaps(navigate: (path: string) => void): () => void {
  if (!isNativeApp()) return () => {};
  let removed = false;
  let remove: (() => void) | null = null;
  void plugin().then(({ LocalNotifications }) =>
    LocalNotifications.addListener("localNotificationActionPerformed", (event) => {
      const route = event.notification.extra?.route;
      navigate(typeof route === "string" ? route : "/daily");
    }).then((handle) => {
      if (removed) void handle.remove();
      else remove = () => void handle.remove();
    })
  );
  return () => {
    removed = true;
    remove?.();
  };
}
