// The small, reusable parts of the multiplayer surface: the room code slab, the
// QR, the phase clock, the connection badge, reactions, and the live region.
//
// They are grouped here because they are all "furniture" — every screen uses
// several of them and none of them owns a screen. The screens themselves
// (MultiplayerPage, RoomPage, DuelSearchPage, RoomDisplayPage) compose these.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  QUICK_MESSAGES,
  REACTIONS,
  type QuickMessageId,
  type ReactionEmoji,
} from "../../../shared/multiplayer/types";
import { MESSAGE_COOLDOWN_MS, MESSAGE_MAX_LENGTH } from "../../../shared/multiplayer/constants";
import { formatRoomCode, roomJoinUrl } from "../../../shared/multiplayer/roomCode";
import { publicOrigin } from "../../lib/origin";
import { renderQr } from "../../lib/mp/qr";
import { motionAllowed } from "../../lib/a11y";
import { sound } from "../../lib/sound";
import { isNativeApp } from "../../lib/platform";
import { Icon } from "../Icon";
import type { LiveMessage, LiveReaction } from "../../lib/mp/useRoom";

/** How long a bubble stays on screen before it fades. */
const MESSAGE_VISIBLE_MS = 4200;
import "./mp.css";

// ------------------------------------------------------------------ QR code

/**
 * The room link as a QR.
 *
 * DARK MODULES ON A LIGHT PANEL, always — this is the one element in the product
 * that does not follow the dark theme, and it is not an oversight. A QR drawn in
 * the page's off-white ink on the navy ground is an INVERTED code, and a good
 * number of phone cameras (including the stock iOS scanner in poor light) simply
 * will not read one. A code that looks right and does not scan is worse than no
 * code, so the panel is light and the modules are the palette's deepest navy.
 *
 * Everything else is ours: one `<path>` of rounded modules rather than the
 * library's table or <img>, so it stays crisp at any size and sits on the
 * product's geometry.
 *
 * The label is the room code, not the URL: a screen-reader user does not want a
 * URL read out, they want the six digits they can type instead.
 */
export function QrCode({ url, code, size = 148 }: { url: string; code: string; size?: number }) {
  const qr = useMemo(() => renderQr(url), [url]);
  return (
    <svg
      className="mp-qr"
      width={size}
      height={size}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      role="img"
      aria-label={`קוד QR להצטרפות לחדר ${formatRoomCode(code)}`}
    >
      {/* The quiet zone is part of the code: the panel must extend past the
          modules or a scanner cannot find the finder patterns. */}
      <rect width={qr.size} height={qr.size} rx="1.5" fill="#f4f3ee" />
      <path d={qr.path} fill="#090f19" />
    </svg>
  );
}

// -------------------------------------------------------------- room code slab

/**
 * The scoreboard slab: the code in broadcast digits, the QR beside it, and the
 * two ways to pass it on.
 *
 * Native share is offered only when the browser actually has it, because a button
 * that silently does nothing is worse than one that is not there. Copy is always
 * available as the fallback that works everywhere.
 */
export function RoomCodePanel({ code, compact = false }: { code: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const url = typeof window === "undefined" ? "" : roomJoinUrl(publicOrigin(), code);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  async function copy() {
    sound.play("click");
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access can be refused; the code is on screen either way.
      setCopied(false);
    }
  }

  async function share() {
    sound.play("click");
    try {
      await navigator.share({ title: "Football IQ", text: `בואו לשחק — קוד חדר ${formatRoomCode(code)}`, url });
    } catch {
      // A cancelled share sheet throws. Nothing to report.
    }
  }

  return (
    <div className={`mp-code ${compact ? "is-compact" : ""}`}>
      <div className="mp-code-main">
        <p className="mp-code-label tiny">קוד חדר</p>
        <p className="mp-code-digits num" aria-label={`קוד חדר ${code.split("").join(" ")}`}>
          {formatRoomCode(code)}
        </p>
        {!compact && (
          <div className="mp-code-actions">
            <button className="btn btn-ghost btn-sm" onClick={copy}>
              <Icon name={copied ? "check" : "share"} size={15} />
              {copied ? "הועתק" : "העתק קישור"}
            </button>
            {canShare && (
              <button className="btn btn-ghost btn-sm" onClick={share}>
                <Icon name="share" size={15} />
                שיתוף
              </button>
            )}
          </div>
        )}
      </div>

      <div className="mp-code-qr">
        <QrCode url={url} code={code} size={compact ? 108 : 132} />
        <p className="tiny mp-code-scan">סרקו כדי להצטרף</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- the clock

/**
 * The phase clock.
 *
 * Driven by a deadline rather than by counting down locally: the server says when
 * the window shuts, and this only draws the gap. A tab that was backgrounded for
 * ten seconds therefore comes back showing the right number instead of ten
 * seconds behind.
 *
 * The ring is decorative; the seconds are the accessible content, and the warning
 * at five seconds is announced as well as sounded so it does not depend on audio.
 */
export function PhaseClock({
  deadlineAt,
  totalMs,
  label,
  onWarning,
}: {
  deadlineAt: number | null;
  totalMs: number;
  label?: string;
  onWarning?: () => void;
}) {
  const [remaining, setRemaining] = useState(() => Math.max(0, (deadlineAt ?? 0) - Date.now()));
  const warnedRef = useRef(false);

  useEffect(() => {
    warnedRef.current = false;
  }, [deadlineAt]);

  useEffect(() => {
    if (deadlineAt === null) return;
    const step = () => {
      const left = Math.max(0, deadlineAt - Date.now());
      setRemaining(left);
      if (!warnedRef.current && left <= 5000 && left > 0) {
        warnedRef.current = true;
        sound.play("timeWarning");
        onWarning?.();
      }
    };
    step();
    const timer = window.setInterval(step, 120);
    return () => window.clearInterval(timer);
  }, [deadlineAt, onWarning]);

  if (deadlineAt === null) return null;

  const seconds = Math.ceil(remaining / 1000);
  const fraction = totalMs > 0 ? Math.max(0, Math.min(1, remaining / totalMs)) : 0;
  const urgent = remaining <= 5000;
  const circumference = 2 * Math.PI * 21;

  return (
    <div className={`mp-clock ${urgent ? "is-urgent" : ""}`} role="timer" aria-live="off">
      <svg viewBox="0 0 48 48" aria-hidden="true" className="mp-clock-ring">
        <circle cx="24" cy="24" r="21" className="mp-clock-track" />
        <circle
          cx="24"
          cy="24"
          r="21"
          className="mp-clock-fill"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          // No CSS transition under reduced motion: the value still steps, it just
          // does not glide.
          style={motionAllowed() ? undefined : { transition: "none" }}
        />
      </svg>
      <span className="mp-clock-num num">{seconds}</span>
      <span className="sr-only">{label ?? "זמן שנותר"}: {seconds} שניות</span>
    </div>
  );
}

// -------------------------------------------------------------- live region

/**
 * The one live region for a multiplayer screen.
 *
 * Everything that happens in a room happens to somebody else's screen too, so
 * without this a screen-reader user would simply not know that a player joined,
 * whose turn it is, or who took the round. `aria-live="polite"` rather than
 * assertive: these are running commentary, not alerts, and interrupting the
 * question being read would be worse than waiting a beat.
 */
export function Announcer({ message }: { message: string }) {
  return (
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </p>
  );
}

// -------------------------------------------------------------- connection

/**
 * The connection badge — visible, because a silent stall looks like a broken
 * game.
 *
 * THE COPY IS THE POINT HERE. The old version had three words for four
 * situations, and the one it had no word for was the one that mattered: a
 * reconnect that has been failing for twenty seconds was labelled the same as
 * one that started half a second ago. So a player on a train saw a cheerful
 * "מתחבר מחדש…" forever, and a player whose connection really was gone was told
 * nothing they could act on.
 *
 * Now `stalled` separates them, and neither message claims to know more than it
 * does. In particular nothing here says the server died: from the client's seat
 * that is indistinguishable from a phone that lost its signal, and the phone is
 * by far the likelier of the two. Saying "we cannot reach the game" is both true
 * and useful; saying "the server stopped responding" is a guess, usually wrong,
 * and tells the player the one thing they definitely cannot fix.
 */
export function ConnectionBadge({
  status,
  stalled = false,
  onRetry,
}: {
  status: "connecting" | "open" | "reconnecting" | "closed";
  stalled?: boolean;
  onRetry?: () => void;
}) {
  if (status === "open") return null;

  const copy =
    status === "connecting"
      ? "מתחבר…"
      : status === "reconnecting"
        ? stalled
          ? "לא מצליחים להתחבר למשחק. ממשיכים לנסות…"
          : "מתחברים מחדש…"
        : "החיבור נסגר";

  return (
    <p className={`mp-conn mp-conn-${status}${stalled ? " mp-conn-stalled" : ""}`} role="status" aria-live="polite">
      <span className="mp-conn-dot" aria-hidden="true" />
      {copy}
      {/* Offered only once trying again is actually the useful move — while a
          first reconnect is in flight it would just interrupt it. */}
      {stalled && onRetry && (
        <button type="button" className="mp-conn-retry" onClick={onRetry}>
          רענון
        </button>
      )}
    </p>
  );
}

// --------------------------------------------------------------- reactions

/**
 * The reaction row.
 *
 * Emoji are the label here, which is the one place in this product they are
 * allowed: they are the content the player is sending, not decoration standing in
 * for an icon. Each button therefore carries a real Hebrew name so the control is
 * usable without seeing the glyph.
 *
 * The server rate-limits these; this also disables the row for the cooldown so the
 * limit is visible rather than arriving as an error.
 */
export function ReactionBar({ onSend, disabled }: { onSend: (emoji: ReactionEmoji) => void; disabled?: boolean }) {
  const [cooling, setCooling] = useState(false);

  function fire(emoji: ReactionEmoji) {
    if (cooling || disabled) return;
    onSend(emoji);
    setCooling(true);
    window.setTimeout(() => setCooling(false), 3000);
  }

  return (
    <div className="mp-reactions" role="group" aria-label="תגובות מהירות">
      {REACTIONS.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          className="mp-reaction"
          onClick={() => fire(reaction.emoji)}
          disabled={cooling || disabled}
          aria-label={reaction.labelHe}
          title={reaction.labelHe}
        >
          <span aria-hidden="true">{reaction.emoji}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Reactions floating up the edge of the screen.
 *
 * Pinned to the inline edge and `pointer-events: none`, so a burst of them can
 * never cover the question or intercept a tap — which is the failure mode that
 * makes reaction features annoying. Under reduced motion they are not rendered at
 * all: the ReactionBar already reports them to the live region.
 */
export function ReactionBurst({ reactions }: { reactions: LiveReaction[] }) {
  if (!motionAllowed()) return null;
  return (
    <div className="mp-burst" aria-hidden="true">
      {reactions.slice(-4).map((reaction) => (
        <span key={reaction.key} className="mp-burst-item">
          {reaction.emoji}
        </span>
      ))}
    </div>
  );
}

// ----------------------------------------------------------- trash talk

/**
 * The trash-talk control: presets first, typing only if you want to.
 *
 * Opening a keyboard mid-question costs more time than the message is worth, so
 * the presets are the primary path and the custom field is behind a second tap.
 * The server enforces the cooldown and the per-question ceiling; this mirrors the
 * cooldown so the limit is visible as a disabled button rather than arriving as an
 * error after the fact.
 */
export function MessageComposer({
  onSend,
  disabled,
}: {
  onSend: (payload: { presetId?: QuickMessageId; text?: string }) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const [typing, setTyping] = useState(false);
  const [cooling, setCooling] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const blocked = cooling || disabled;

  function fire(payload: { presetId?: QuickMessageId; text?: string }) {
    if (blocked) return;
    onSend(payload);
    setCooling(true);
    window.setTimeout(() => setCooling(false), MESSAGE_COOLDOWN_MS);
    setOpen(false);
    setTyping(false);
    setCustom("");
  }

  // Escape closes, and focus returns to nothing in particular — the panel is
  // transient furniture over a live game, not a dialog to be trapped in.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setTyping(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const remaining = MESSAGE_MAX_LENGTH - [...custom].length;

  return (
    <div className="mp-talk" ref={panelRef}>
      <button
        type="button"
        className="mp-talk-toggle"
        onClick={() => setOpen((v) => !v)}
        disabled={blocked}
        aria-expanded={open}
        aria-label="הודעה ליריב"
        title="הודעה ליריב"
      >
        <Icon name="chat" />
        <span className="mp-talk-toggle-label">הודעה ליריב</span>
      </button>

      {open && (
        <div className="mp-talk-panel" role="group" aria-label="הודעה ליריב">
          <div className="mp-talk-presets">
            {QUICK_MESSAGES.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="mp-talk-preset"
                onClick={() => fire({ presetId: preset.id })}
                disabled={blocked}
              >
                {preset.textHe}
              </button>
            ))}
          </div>

          {/* The app sends presets only (see shouldShowMessage in useRoom). */}
          {isNativeApp() ? null : typing ? (
            <form
              className="mp-talk-custom"
              onSubmit={(event) => {
                event.preventDefault();
                if (custom.trim()) fire({ text: custom });
              }}
            >
              <input
                type="text"
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
                maxLength={MESSAGE_MAX_LENGTH}
                placeholder="הודעה קצרה..."
                aria-label="הודעה חופשית"
                autoFocus
              />
              <span className="mp-talk-count" aria-hidden="true">
                {remaining}
              </span>
              <button type="submit" className="btn btn-sm" disabled={blocked || !custom.trim()}>
                שלח
              </button>
            </form>
          ) : (
            <button type="button" className="btn btn-quiet btn-sm mp-talk-open-custom" onClick={() => setTyping(true)}>
              הודעה משלי
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Incoming messages, as speech bubbles.
 *
 * Laid out like a broadcast lower-third and pinned with `pointer-events: none`, so
 * a bubble can never sit on top of an answer button or swallow a tap — the failure
 * that makes this kind of feature actively hostile on a phone.
 *
 * Under reduced motion the bubbles still appear, because unlike a decorative
 * emoji burst they carry words somebody sent; they simply do not animate. Nothing
 * here is announced either: useRoom already writes the message to the live region
 * once, and repeating it per bubble is how a screen reader ends up reciting the
 * same jibe three times.
 */
export function MessageBubbles({ messages }: { messages: LiveMessage[] }) {
  const [now, setNow] = useState(() => Date.now());

  // One timer for the whole stack rather than one per bubble.
  useEffect(() => {
    if (messages.length === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [messages.length]);

  const visible = messages.filter((m) => now - m.at < MESSAGE_VISIBLE_MS);
  if (visible.length === 0) return null;

  return (
    <div className="mp-talk-bubbles" aria-hidden="true">
      {visible.map((message) => (
        <div
          key={message.key}
          className={`mp-talk-bubble${motionAllowed() ? " a-pop" : ""}`}
          data-leaving={now - message.at > MESSAGE_VISIBLE_MS - 400 ? "true" : undefined}
        >
          <span className="mp-talk-bubble-name">{message.name}</span>
          <span className="mp-talk-bubble-text">{message.text}</span>
        </div>
      ))}
    </div>
  );
}
