import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { accountsAvailable, deleteAccount, refreshAccount, renameAccount, signOut, useAccount } from "../lib/account";
import { messageHeOf } from "../lib/api";
import { rememberPlayerName } from "../lib/mp/identity";
import { sound } from "../lib/sound";
import { AppleLogo } from "../components/AccountSheet";
import { Icon } from "../components/Icon";
import { MAX_NAME_LENGTH } from "../../shared/multiplayer/constants";
import "./ProfilePage.css";

/**
 * The signed-in player's own page: their name, their numbers, and the way out.
 *
 * `?welcome=1` is a brand-new account: the name opens for editing straight
 * away, prefilled with whatever the device already called them.
 */
export function ProfilePage() {
  const account = useAccount();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const welcome = params.get("welcome") === "1";

  const [editing, setEditing] = useState(welcome);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!accountsAvailable() || account.status === "guest") navigate("/", { replace: true });
  }, [account.status, navigate]);

  useEffect(() => {
    void refreshAccount();
  }, []);

  const displayName = account.status === "signed-in" ? account.user.displayName : "";

  useEffect(() => {
    if (editing) {
      setDraft(displayName);
      inputRef.current?.focus();
    }
  }, [editing, displayName]);

  if (account.status !== "signed-in") {
    return (
      <div className="page profile">
        <p className="profile-loading">טוען…</p>
      </div>
    );
  }

  const { stats } = account;
  const initial = Array.from(displayName.trim())[0] ?? "";

  async function saveName(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await renameAccount(draft);
      // Multiplayer reads its own saved name; keep the two in step.
      rememberPlayerName(draft.trim());
      sound.play("select");
      setEditing(false);
    } catch (e) {
      setError(messageHeOf(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page profile">
      <div className="profile-head a-fade-up">
        <span className="profile-avatar" aria-hidden="true">
          {initial || <Icon name="user" size={36} />}
        </span>

        {editing ? (
          <form className="profile-name-form" onSubmit={saveName}>
            {welcome && <p className="profile-welcome">ברוכים הבאים! איך לקרוא לכם?</p>}
            <label className="sr-only" htmlFor="profile-name">
              השם שלכם
            </label>
            <input
              id="profile-name"
              ref={inputRef}
              className="profile-name-input"
              value={draft}
              maxLength={MAX_NAME_LENGTH}
              onChange={(event) => setDraft(event.target.value)}
              autoComplete="nickname"
              enterKeyHint="done"
            />
            <div className="row g2 profile-name-actions">
              <button className="btn btn-primary" type="submit" disabled={saving || draft.trim().length === 0}>
                {saving ? "שומר…" : "שמירה"}
              </button>
              {!welcome && (
                <button className="btn btn-quiet" type="button" onClick={() => setEditing(false)}>
                  ביטול
                </button>
              )}
            </div>
            {error && (
              <p className="profile-error" role="alert">
                {error}
              </p>
            )}
          </form>
        ) : (
          <div className="profile-name-row">
            <h1 className="profile-name">{displayName}</h1>
            <button className="icon-btn" type="button" aria-label="עריכת השם" onClick={() => setEditing(true)}>
              <Icon name="pencil" size={16} />
            </button>
          </div>
        )}

        <span className="profile-provider">
          <AppleLogo color="currentColor" size={12} />
          מחובר עם Apple
        </span>
      </div>

      <h2 className="profile-section-title">הסטטיסטיקה שלי</h2>
      <div className="profile-stats a-stagger">
        <Stat value={stats?.quizzesPlayed} label="חידונים ששוחקו" i={0} />
        <Stat value={stats?.bestQuizScore} label="הניקוד הכי גבוה" tone="gold" i={1} />
        <Stat
          value={stats ? `${stats.duelsWon}–${stats.duelsLost}` : undefined}
          label="דו־קרבות: ניצחונות–הפסדים"
          i={2}
        />
        <Stat value={stats?.bestStreak} label="רצף תשובות שיא" tone="green" i={3} />
      </div>

      <div className="profile-actions">
        <button
          className="btn btn-ghost btn-lg"
          onClick={async () => {
            sound.play("click");
            await signOut();
            navigate("/", { replace: true });
          }}
        >
          התנתקות
        </button>
        <button
          className="btn btn-quiet profile-delete"
          onClick={() => {
            sound.play("click");
            setConfirmingDelete(true);
          }}
        >
          מחיקת החשבון
        </button>
      </div>

      {confirmingDelete && (
        <DeleteAccountSheet
          onDismiss={() => setConfirmingDelete(false)}
          onDeleted={() => navigate("/", { replace: true })}
        />
      )}
    </div>
  );
}

/**
 * The last step before deletion: says plainly what goes and that it cannot be
 * undone. Cancel is the focused, safe default.
 */
function DeleteAccountSheet({ onDismiss, onDeleted }: { onDismiss: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss, busy]);

  async function confirm() {
    setError(null);
    setBusy(true);
    try {
      await deleteAccount();
      onDeleted();
    } catch (e) {
      setError(messageHeOf(e));
      setBusy(false);
    }
  }

  return (
    <div className="account-sheet-backdrop" onClick={busy ? undefined : onDismiss}>
      <div
        className="account-sheet"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-account-title"
        aria-describedby="delete-account-body"
        onClick={(event) => event.stopPropagation()}
      >
        <span className="account-sheet-badge is-danger" aria-hidden="true">
          <Icon name="cross" size={26} />
        </span>
        <h2 id="delete-account-title" className="account-sheet-title">
          למחוק את החשבון?
        </h2>
        <p id="delete-account-body" className="account-sheet-sub profile-delete-body">
          זה מוחק לצמיתות את השם, הסטטיסטיקה והקישור ל-Apple. אי אפשר לשחזר.
          <br />
          אפשר להמשיך לשחק כאורח.
        </p>

        <button className="btn btn-lg profile-delete-confirm" onClick={confirm} disabled={busy} aria-busy={busy}>
          {busy ? "מוחק…" : "כן, למחוק לצמיתות"}
        </button>
        {error && (
          <p className="account-sheet-error" role="alert">
            {error}
          </p>
        )}
        <button ref={cancelRef} className="btn btn-quiet account-sheet-guest" onClick={onDismiss} disabled={busy}>
          ביטול
        </button>
      </div>
    </div>
  );
}

function Stat({ value, label, tone, i }: { value: number | string | undefined; label: string; tone?: "gold" | "green"; i: number }) {
  return (
    <div className="profile-stat" style={{ "--i": i } as React.CSSProperties}>
      <span className={`profile-stat-value${tone ? ` is-${tone}` : ""}`}>{value ?? "—"}</span>
      <span className="profile-stat-label">{label}</span>
    </div>
  );
}
