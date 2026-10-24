// One drawn icon set, so nothing in the product is an emoji.
//
// Emoji are the single loudest "generated template" tell: they render as a
// different vendor's artwork on every OS, they never match the typography, and
// they cannot take the ink colour. Every mark here is drawn on the same
// 24-unit grid with the same 1.7 stroke weight, round joins, and inherits
// `currentColor`, so a mark inside a stamp picks up the stamp's colour for free.
//
// Decorative by default (`aria-hidden`). Pass a `title` only when the icon is
// the sole carrier of meaning; it then becomes an accessible image.

export type IconName =
  | "ball"
  | "boot"
  | "trophy"
  | "whistle"
  | "globe"
  | "flame"
  | "sound-on"
  | "sound-off"
  | "check"
  | "cross"
  | "eye"
  | "bulb"
  | "keyboard"
  | "list"
  | "shield"
  | "shirt"
  | "calendar"
  | "share"
  | "replay"
  | "lock"
  | "arrow"
  | "clock"
  | "target"
  | "user"
  | "pencil"
  | "sliders"
  | "stadium"
  | "route"
  | "accessibility"
  | "chat";

interface Props {
  name: IconName;
  size?: number;
  title?: string;
  className?: string;
  strokeWidth?: number;
}

/* Each entry is the inner geometry only — the <svg> wrapper is shared so the
   stroke language can never drift between marks. */
const PATHS: Record<IconName, React.ReactNode> = {
  ball: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6.4l3.4 2.5-1.3 4h-4.2l-1.3-4z" />
      <path d="M12 3v3.4M8.6 8.9L5.4 7.6M15.4 8.9l3.2-1.3M9.9 12.9l-1.7 3.4M14.1 12.9l1.7 3.4" />
    </>
  ),
  boot: (
    <>
      <path d="M4 7h5.5l2 4.6H17a3 3 0 013 3V17H4z" />
      <path d="M4 17.5h16.5" />
      <path d="M7.5 17v1.6M11 17v1.6M14.5 17v1.6" />
    </>
  ),
  trophy: (
    <>
      <path d="M7.5 4h9v4.5a4.5 4.5 0 01-9 0z" />
      <path d="M7.5 5.5H5a2.5 2.5 0 002.5 2.5M16.5 5.5H19a2.5 2.5 0 01-2.5 2.5" />
      <path d="M12 13v3.5M8.5 20h7M9.5 20l.6-3.5h3.8l.6 3.5" />
    </>
  ),
  whistle: (
    <>
      <path d="M14 8.5a5 5 0 100 7H7.5a3.5 3.5 0 010-7z" />
      <circle cx="10" cy="12" r="1.6" />
      <path d="M14 8.5l5.5-2.5M17 12h3.5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.6 2.6 2.6 15.4 0 18-2.6-2.6-2.6-15.4 0-18z" />
    </>
  ),
  flame: (
    <>
      <path d="M12 21c3.6 0 6-2.3 6-5.6 0-4.2-4.2-5.6-4.2-9.4-2 1-3.2 2.8-3.2 4.8 0 1.2.4 2 .4 2.6 0 .9-.6 1.5-1.4 1.5-.9 0-1.5-.7-1.6-1.9C6.7 14.3 6 15.4 6 17c0 2.4 2.4 4 6 4z" />
    </>
  ),
  "sound-on": (
    <>
      <path d="M4 9.5h3L11.5 6v12L7 14.5H4z" />
      <path d="M15 9.5a3.5 3.5 0 010 5M17.5 7a7 7 0 010 10" />
    </>
  ),
  "sound-off": (
    <>
      <path d="M4 9.5h3L11.5 6v12L7 14.5H4z" />
      <path d="M15.5 10l5 4M20.5 10l-5 4" />
    </>
  ),
  check: <path d="M4.5 12.8l4.6 4.4L19.5 6.8" />,
  cross: <path d="M6 6l12 12M18 6L6 18" />,
  eye: (
    <>
      <path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  bulb: (
    <>
      <path d="M8.5 13.5a5 5 0 117 0c-.9 1-1.2 1.7-1.3 3h-4.4c-.1-1.3-.4-2-1.3-3z" />
      <path d="M9.8 19.5h4.4M10.5 21.5h3" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2.5" y="6.5" width="19" height="11" rx="1.5" />
      <path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 14h12" />
    </>
  ),
  list: (
    <>
      <path d="M9 7h11M9 12h11M9 17h11" />
      <path d="M4 7h.01M4 12h.01M4 17h.01" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7.5 2.5v6c0 4.4-3.1 8.2-7.5 9.5-4.4-1.3-7.5-5.1-7.5-9.5v-6z" />
      <path d="M12 8.5v5" />
    </>
  ),
  shirt: (
    <>
      <path d="M9 3.5L4 6l1.5 4L8 9.2V20h8V9.2L18.5 10 20 6l-5-2.5z" />
      <path d="M9 3.5a3 3 0 006 0" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5.5" width="17" height="15" rx="1.5" />
      <path d="M3.5 10h17M8 3.5v4M16 3.5v4" />
      <path d="M8 14h3v3H8z" />
    </>
  ),
  share: (
    <>
      <circle cx="18" cy="6" r="2.8" />
      <circle cx="6" cy="12" r="2.8" />
      <circle cx="18" cy="18" r="2.8" />
      <path d="M15.6 7.4l-7.2 3.2M8.4 13.4l7.2 3.2" />
    </>
  ),
  replay: (
    <>
      <path d="M20 12a8 8 0 11-2.6-5.9" />
      <path d="M20.5 4v4.5H16" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="10.5" width="15" height="10" rx="1.5" />
      <path d="M8 10.5V8a4 4 0 018 0v2.5" />
      <path d="M12 14.5v2.5" />
    </>
  ),
  arrow: <path d="M20 12H4M10.5 5.5L4 12l6.5 6.5" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3.5 2" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="0.9" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20c1-3.8 4-6 7.5-6s6.5 2.2 7.5 6" />
    </>
  ),
  pencil: <path d="M4 20h4L19 9l-4-4L4 16z" />,
  sliders: (
    <>
      <path d="M4 8h10M18 8h2M4 16h4M12 16h8" />
      <circle cx="16" cy="8" r="2" />
      <circle cx="10" cy="16" r="2" />
    </>
  ),
  stadium: (
    <>
      <path d="M3 8.5c0-2 4-3.5 9-3.5s9 1.5 9 3.5v7c0 2-4 3.5-9 3.5s-9-1.5-9-3.5z" />
      <path d="M3 8.5c0 2 4 3.5 9 3.5s9-1.5 9-3.5" />
      <path d="M12 12v7" />
    </>
  ),
  /* A speech bubble with a tail, for the trash-talk control. */
  chat: (
    <>
      <path d="M20 12.5a6.5 6.5 0 01-6.5 6.5H9l-4 3v-3.8A6.5 6.5 0 014 12.5v-1A6.5 6.5 0 0110.5 5h3A6.5 6.5 0 0120 11.5z" />
      <path d="M9 12h6" />
    </>
  ),
  route: (
    <>
      <circle cx="6.5" cy="6" r="2.5" />
      <circle cx="17.5" cy="18" r="2.5" />
      <path d="M6.5 8.5v4a3 3 0 003 3h5a3 3 0 013 3v-.5" />
    </>
  ),
  /* The standard "person" accessibility figure, drawn in this set's stroke. */
  accessibility: (
    <>
      <circle cx="12" cy="4.4" r="1.9" />
      <path d="M4.5 8.2c2.4.8 4.9 1.2 7.5 1.2s5.1-.4 7.5-1.2" />
      <path d="M12 9.4v5.2M12 14.6l-3.2 5M12 14.6l3.2 5" />
    </>
  ),
};

export function Icon({ name, size = 20, title, className, strokeWidth = 1.7 }: Props) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
      style={{ flex: "none" }}
    >
      {title && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  );
}

/* The flame is the one solid mark — a streak should read as filled, not
   outlined, so it carries weight in the scoreboard at small sizes. */
export function FlameMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" style={{ flex: "none" }}>
      <path d="M12 22c4 0 6.6-2.5 6.6-6.2 0-4.6-4.6-6.2-4.6-10.3-2.3 1.1-3.6 3.1-3.6 5.3 0 1.3.4 2.2.4 2.9 0 1-.6 1.6-1.5 1.6s-1.6-.7-1.7-2.1C6.1 14.8 5.4 16 5.4 17.8 5.4 20.4 8 22 12 22z" />
    </svg>
  );
}
