import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Quiz } from "../../shared/types";
import { fetchDaily, messageHeOf } from "../lib/api";
import { saveActiveQuiz } from "../lib/quizSession";
import { sound } from "../lib/sound";
import { Icon } from "../components/Icon";
import { Loading } from "../components/Loading";
import { loadDailyRecord } from "../lib/dailyRecord";
import "./IntroPage.css";

export function DailyPage() {
  const navigate = useNavigate();
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setError(null);
    fetchDaily()
      .then((res) => {
        setQuiz(res.quiz);
        setDate(res.date);
      })
      // Says which failure it was — no connection, too slow, or the server
      // refusing — rather than one sentence covering all three. The client can
      // now tell them apart, so it should.
      .catch((e) => setError(messageHeOf(e, "לא הצלחנו לטעון את אתגר היום. נסו שוב מאוחר יותר.")));
  }, [attempt]);

  const record = date ? loadDailyRecord(date) : null;
  const dateHe = date
    ? new Date(`${date}T12:00:00`).toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" })
    : null;

  function start() {
    if (!quiz) return;
    sound.play("click");
    saveActiveQuiz({ quiz, startedAt: Date.now(), isDaily: true, dailyDate: date ?? undefined });
    navigate("/play");
  }

  return (
    <div className="page gate">
      {error && (
        <div className="plate a-pop">
          <span className="plate-mark">
            <Icon name="calendar" size={23} />
          </span>
          <h1 className="plate-title">אתגר היום לא נטען</h1>
          <p className="plate-text">{error}</p>
          <button className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>
            <Icon name="replay" size={17} />
            נסו שוב
          </button>
          <button className="btn btn-ghost" onClick={() => navigate("/build")}>
            בנו חידון משלכם
          </button>
        </div>
      )}

      {!error && !quiz && <Loading label="טוען את אתגר היום" />}

      {quiz && (
        <div className="plate a-pop">
          <span className="plate-mark">
            <Icon name="calendar" size={23} />
          </span>
          <h1 className="plate-title">אתגר יומי</h1>
          <div className="plate-meta">
            <span className="tag tag-green">{dateHe}</span>
            <span className="tag">{quiz.questions.length} שאלות</span>
          </div>
          {record ? (
            <>
              <p className="plate-text">
                כבר שיחקתם היום: <b className="num">{record.correct}/{record.total}</b> ·{" "}
                <b className="num">{record.points}</b> נק׳. סבב חדש יעלה מחר.
              </p>
              <button className="btn btn-ghost" onClick={start}>
                <Icon name="replay" size={17} />
                לשחק שוב (לא נספר)
              </button>
            </>
          ) : (
            <>
              <p className="plate-text">אותן שאלות לכל מי שנכנס היום. מחר נטען סבב חדש.</p>
              <button className="btn btn-primary" onClick={start}>
                התחילו
                <Icon name="arrow" size={17} />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
