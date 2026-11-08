import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { COMPETITIONS, COUNTRIES, DIFFICULTY_LABELS } from "../../shared/constants";
import type { AnswerMode, Difficulty, Region } from "../../shared/types";
import { fetchAvailability, messageHeOf, type AvailabilityResponse } from "../lib/api";
import {
  competitionsForCountry,
  COUNT_CHOICES,
  countriesIn,
  DIFFICULTY_CHOICES,
  DIFFICULTY_COMMON,
  INITIAL_STATE,
  isOfferableStrict,
  isPickedLeague,
  offerableScopes,
  offerableTypes,
  pickerConfiguration,
  repair,
  SCOPE_ALL,
  scopeLabel,
  SUPPORTED_CONTINENTS,
  toConfiguration,
  typeLabel,
  type BuilderState,
} from "../lib/builderWizard";
import { startQuiz } from "../lib/startQuiz";
import { sound } from "../lib/sound";
import { Icon } from "../components/Icon";
import "./BuilderPage.css";

const ANSWER_MODES: { key: AnswerMode; label: string }[] = [
  { key: "MULTIPLE_CHOICE", label: "אמריקאי" },
  { key: "FREE_TEXT", label: "פתוח" },
];

const competitionLabel = (code: string) => COMPETITIONS.find((c) => c.code === code)?.nameHe ?? code;
const countryLabel = (code: string) => COUNTRIES.find((c) => c.code === code)?.nameHe ?? code;
const continentLabel = (code: Region | null) =>
  SUPPORTED_CONTINENTS.find((c) => c.code === code)?.labelHe ?? "";

/**
 * Create a game.
 *
 * ONE SCREEN, FIVE ROWS, AND START ALREADY WORKS.
 *
 * The eight-step wizard this replaces was not too sparse or too dense; it was
 * too much CEREMONY. A player who wants a game should not have to answer four
 * questions to get one, so the defaults here are a real quiz — free text, mixed
 * difficulty, ten questions, mixed type, everywhere — and the screen opens with
 * Start live and nothing that has to be touched.
 *
 * WHAT IS NOT ON SCREEN IS THE OTHER HALF. An option that cannot fill the
 * requested quiz is absent, not disabled. The previous build greyed such options
 * out and explained why, which is honest and still wrong: it turns the screen
 * into a list of things you cannot have. Hiding them means every visible choice
 * leads to a game, so a dead end is impossible rather than unlikely. See
 * `isOfferable` and `repair` in lib/builderWizard.
 *
 * Geography is optional. "Everywhere", "the big six" and "Israel" are pills;
 * continent → country → league lives behind "בחר ליגה" for the few who want it.
 */
export function BuilderPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<BuilderState>(INITIAL_STATE);
  const [showMoreTypes, setShowMoreTypes] = useState(false);
  const [picker, setPicker] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<AvailabilityResponse | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const config = useMemo(() => toConfiguration(state), [state]);

  const patch = (next: Partial<BuilderState>) => {
    sound.play("select");
    setState((prev) => ({ ...prev, ...next }));
  };

  /*
    ONE REQUEST PER CHANGE, DEBOUNCED, FOR THE WHOLE SCREEN.

    `types` and `presets` come back together, and each is measured with its OWN
    dimension removed — so a type's count reflects the chosen scope and a
    preset's count reflects the chosen type. That is what makes the two rows
    filter each other rather than only themselves. `total` is the figure beside
    Start. Server-side it is one GROUP BY plus eleven capped counts in a single
    batch, cached at the edge for five minutes; one tap never costs more than
    one call.
  */
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchAvailability(config, ["types", "presets"], { anyMode: true })
        .then((res) => !cancelled && setOptions(res))
        .catch(() => !cancelled && setOptions(null));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [config]);

  /*
    A selection the latest counts can no longer serve is replaced, not kept.

    Choices interact — asking for twenty questions can empty a type that was
    fine at five — and a state the screen no longer offers is the dead end in
    slow motion. `repair` returns the same object when nothing is wrong, so this
    cannot loop.
  */
  useEffect(() => {
    setState((prev) => repair(prev, options));
  }, [options]);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const types = offerableTypes(options, state.questionCount, showMoreTypes);
  const scopes = offerableScopes(options, state.questionCount);
  const picked = isPickedLeague(state);
  const total = options?.total ?? null;
  const canStart = total === null || total >= 1;

  async function start() {
    setError(null);
    setStarting(true);
    sound.play("click");
    try {
      await startQuiz(navigate, config);
    } catch (e) {
      setError(messageHeOf(e));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="page bld">
      <h1 className="bld-title" ref={headingRef} tabIndex={-1}>
        בנו חידון
      </h1>

      <Row label="איך עונים?">
        {ANSWER_MODES.map((mode) => (
          <Pill
            key={mode.key}
            label={mode.label}
            on={state.answerMode === mode.key}
            onClick={() => patch({ answerMode: mode.key })}
          />
        ))}
      </Row>

      <Row label="קושי">
        {DIFFICULTY_CHOICES.map((d) => (
          <Pill
            key={d}
            label={d === "MIXED" ? "מעורב" : DIFFICULTY_LABELS[d as Difficulty]}
            on={state.difficulty === d}
            common={DIFFICULTY_COMMON.includes(d)}
            onClick={() => patch({ difficulty: d })}
          />
        ))}
      </Row>

      <Row label="שאלות">
        {COUNT_CHOICES.map((n) => (
          <Pill
            key={n}
            label={String(n)}
            on={state.questionCount === n}
            narrow
            onClick={() => patch({ questionCount: n })}
          />
        ))}
      </Row>

      <Row label="סוג">
        {types.map((key) => (
          <Pill
            key={key}
            label={typeLabel(key)}
            on={state.questionType === key}
            onClick={() => patch({ questionType: key })}
          />
        ))}
        {/* The remaining types are real and stay reachable; nobody has to read
            thirteen options to start a mixed game. Styled as an ACTION rather
            than a pill — see the Action component for why the difference
            matters more than the wording. */}
        <Action
          label={showMoreTypes ? "הצג פחות" : "עוד סוגים"}
          icon={showMoreTypes ? "cross" : "sliders"}
          expanded={showMoreTypes}
          onClick={() => {
            sound.play("select");
            setShowMoreTypes((v) => !v);
          }}
        />
      </Row>

      <Row label="מאיפה?">
        {scopes.map((choice) => (
          <Pill
            key={choice.key}
            label={choice.labelHe}
            on={state.scope === choice.key}
            onClick={() => patch({ scope: choice.key, scopeCountry: null })}
          />
        ))}
        {/* A league chosen in the picker is not one of the pills, so it gets one
            of its own — otherwise the narrower choice would be invisible beside
            the quick scopes. It names the country too: "ספרד · לה ליגה". */}
        {picked && <Pill label={scopeLabel(state)} on onClick={() => setPicker(true)} />}
        <Action
          label={picked ? "שנה ליגה" : "בחירת ליגה"}
          icon="shield"
          onClick={() => {
            sound.play("select");
            setPicker(true);
          }}
        />
      </Row>

      <div className="bld-dock">
        <div className="page bld-dock-inner">
          {error && (
            <p className="bld-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn-primary btn-block" disabled={starting || !canStart} onClick={start}>
            {starting ? "יוצר…" : "התחילו משחק"}
            {!starting && <Icon name="arrow" size={17} />}
          </button>
          <p className="bld-avail" role="status" aria-live="polite">
            {total === null ? (
              <span className="faint">בודקים זמינות…</span>
            ) : (
              <>
                <b className="num green">{total.toLocaleString("he-IL")}</b> שאלות מתאימות
              </>
            )}
          </p>
        </div>
      </div>

      {picker && (
        <LeaguePicker
          state={state}
          onClose={() => setPicker(false)}
          onPick={(competition, country) => {
            sound.play("select");
            setState((prev) => ({ ...prev, scope: competition, scopeCountry: country }));
            setPicker(false);
          }}
        />
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="bld-row">
      <h2 className="bld-row-label">{label}</h2>
      <div className="bld-pills" role="group" aria-label={label}>
        {children}
      </div>
    </section>
  );
}

/**
 * One compact choice.
 *
 * Selection shows three ways — border, background and a tick — because colour
 * alone fails for a colour-blind player and in bright sunlight, which is where
 * a phone usually is.
 */
function Pill({
  label,
  on,
  onClick,
  common = false,
  quiet = false,
  narrow = false,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
  common?: boolean;
  quiet?: boolean;
  narrow?: boolean;
}) {
  return (
    <button
      type="button"
      className={`bld-pill${on ? " is-on" : ""}${common ? " is-common" : ""}${quiet ? " is-quiet" : ""}${narrow ? " is-narrow" : ""}`}
      aria-pressed={on}
      onClick={onClick}
    >
      {on && <Icon name="check" size={13} />}
      {label}
    </button>
  );
}

/**
 * A control that OPENS something, as opposed to one that selects something.
 *
 * THE DISTINCTION THESE TWO CONTROLS KEPT LOSING. The builder has two kinds of
 * thing in the same rows: direct choices (הכל, טופ 6, מי אני?) and doors
 * (בחירת ליגה, עוד סוגים). They were styled as the same pill with a dashed
 * border and muted text, which made the doors read as LESS important than the
 * choices beside them — the exact opposite of what they are. A player scanning
 * the row saw a greyed-out chip and took it for an option that was unavailable.
 *
 * So a door looks like a door: full-strength text, a solid border, an icon that
 * says what is behind it, and a chevron pointing the way. The chevron is the
 * part that carries the meaning — it is the one mark in this screen that says
 * "there is more through here" rather than "this is a thing you can pick".
 */
function Action({
  label,
  icon,
  onClick,
  expanded = false,
}: {
  label: string;
  icon: string;
  onClick: () => void;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      className={`bld-action${expanded ? " is-expanded" : ""}`}
      onClick={onClick}
      aria-expanded={expanded || undefined}
    >
      <Icon name={icon as never} size={14} />
      {label}
      <Icon name="arrow" size={13} />
    </button>
  );
}

/**
 * Continent → country → league, on demand.
 *
 * A sheet rather than three steps: this is the one place in the builder where
 * drilling down is the point, and also the one place most players will never
 * open. Each level shows only what can fill the requested quiz, measured against
 * everything else already chosen, so the picker cannot be walked into a
 * combination with nothing behind it.
 */
function LeaguePicker({
  state,
  onClose,
  onPick,
}: {
  state: BuilderState;
  onClose: () => void;
  onPick: (competition: string, country: string | null) => void;
}) {
  const [continent, setContinent] = useState<Region | null>(null);
  const [country, setCountry] = useState<string | null>(null);
  const [counts, setCounts] = useState<AvailabilityResponse | null>(null);

  const wanted = state.questionCount;
  const { difficulty, answerMode, questionType } = state;

  useEffect(() => {
    let cancelled = false;
    const dimensions = country ? ["competitions"] : continent ? ["countries"] : ["continents"];
    fetchAvailability(pickerConfiguration(state, country), dimensions, { anyMode: true })
      .then((res) => !cancelled && setCounts(res))
      .catch(() => !cancelled && setCounts(null));
    return () => {
      cancelled = true;
    };
    // The rest of the selection is read so the counts respect it; only the
    // level being browsed and those values change what has to be fetched.
  }, [continent, country, wanted, difficulty, answerMode, questionType, state]);

  // Strict here, deliberately: a level is rendered only once its counts are in
  // hand, so an option missing from the response has none rather than unknown.
  const continents = SUPPORTED_CONTINENTS.filter((c) =>
    isOfferableStrict(counts?.continents, c.code, wanted)
  );
  const countryList = continent
    ? countriesIn(continent).filter((c) => isOfferableStrict(counts?.countries, c.code, wanted))
    : [];
  const competitionList = country
    ? competitionsForCountry(country).filter((code) =>
        isOfferableStrict(counts?.competitions, code, wanted)
      )
    : [];

  const back = () => {
    if (country) setCountry(null);
    else if (continent) setContinent(null);
    else onClose();
  };

  const nothingHere =
    (!continent && counts !== null && continents.length === 0) ||
    (continent && !country && counts !== null && countryList.length === 0) ||
    (country && counts !== null && competitionList.length === 0);

  return (
    <div className="bld-sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="bld-sheet"
        role="dialog"
        aria-label="בחירת ליגה"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bld-sheet-head">
          <button className="bld-sheet-back" onClick={back} aria-label="חזרה">
            <Icon name="arrow" size={16} />
          </button>
          {/* The flow is NAMED, every level, so the panel is obviously the
              thing the button opened; the breadcrumb under it says how far in
              you are and what you picked on the way. */}
          <div className="bld-sheet-heading">
            <h2 className="bld-sheet-title">בחירת ליגה</h2>
            <p className="bld-sheet-crumb">
              {country
                ? `${continentLabel(continent)} › ${countryLabel(country)} › איזו ליגה?`
                : continent
                  ? `${continentLabel(continent)} › איזו מדינה?`
                  : "איזו יבשת?"}
            </p>
          </div>
          <button className="bld-sheet-close" onClick={onClose} aria-label="סגירה">
            <Icon name="cross" size={15} />
          </button>
        </div>

        <div className="bld-sheet-body">
          {!continent &&
            continents.map((c) => (
              <SheetRow
                key={c.code}
                label={c.labelHe}
                count={counts?.continents?.[c.code]}
                onClick={() => setContinent(c.code)}
              />
            ))}

          {continent &&
            !country &&
            countryList.map((c) => (
              <SheetRow
                key={c.code}
                label={`${c.flag} ${c.nameHe}`}
                count={counts?.countries?.[c.code]}
                onClick={() => setCountry(c.code)}
              />
            ))}

          {country &&
            competitionList.map((code) => (
              <SheetRow
                key={code}
                label={competitionLabel(code)}
                count={counts?.competitions?.[code]}
                onClick={() => onPick(code, country)}
              />
            ))}

          {nothingHere && (
            <p className="bld-sheet-empty">
              אין כאן מספיק שאלות. נסו פחות שאלות או קושי מעורב.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One row in the picker, with its count.
 *
 * The one place counts appear, because it is the one place they help: choosing
 * between Spain and Greece is a question about depth. On the main screen the
 * same numbers on every pill would be noise.
 */
function SheetRow({ label, count, onClick }: { label: string; count?: number; onClick: () => void }) {
  return (
    <button type="button" className="bld-sheet-row" onClick={onClick}>
      <span className="bld-sheet-row-label">{label}</span>
      {count !== undefined && <span className="bld-sheet-count num">{count.toLocaleString("he-IL")}</span>}
      <Icon name="arrow" size={14} />
    </button>
  );
}
