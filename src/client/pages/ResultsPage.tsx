import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CATEGORIES } from "../../shared/constants";
import type { Category } from "../../shared/types";
import { createChallenge, fetchQuiz, messageHeOf } from "../lib/api";
import { loadResult, saveActiveQuiz } from "../lib/quizSession";
import { getRecentQuestionIds } from "../lib/recentQuestions";
import { publicOrigin } from "../lib/origin";
import { ScoreRing } from "../components/ScoreRing";
import { Confetti } from "../components/Confetti";
import { Icon, FlameMark } from "../components/Icon";
import { sound } from "../lib/sound";
import "./ResultsPage.css";

function mmss(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const CATEGORY_LABELS: Record<string, string> = Object.fromEntries(CATEGORIES.map((c) => [c.code, c.labelHe]));

export function ResultsPage() {
  const navigate = useNavigate();
  const result = useMemo(() => loadResult(), []);
  const [replaying, setReplaying] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareMessage, setShareMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!result) navigate("/", { replace: true });
  }, [result, navigate]);

  const breakdown = useMemo(() => {
    if (!result) return [];
    const map = new Map<Category, { correct: number; total: number }>();
    for (const answer of result.answers) {
      const question = result.quiz.questions.find((q) => q.id === answer.questionId);
      if (!question) continue;
      const entry = map.get(question.category) ?? { correct: 0, total: 0 };
      entry.total += 1;
      if (answer.correct) entry.correct += 1;
      map.set(question.category, entry);
    }
    return [...map.entries()].sort((a, b) => b[1].correct / b[1].total - a[1].correct / a[1].total);
  }, [result]);

  if (!result) return null;
  const { quiz, score, durationSeconds } = result;

  async function handleReplay() {
    setReplaying(true);
    sound.play("click");
    try {
      const fresh = await fetchQuiz({ ...quiz.configuration, excludeQuestionIds: getRecentQuestionIds() });
      saveActiveQuiz({ quiz: fresh, startedAt: Date.now() });
      navigate("/play");
    } catch (e) {
      setShareMessage(messageHeOf(e, "לא הצלחנו לטעון סבב חדש, נסו שוב."));
    } finally {
      setReplaying(false);
    }
  }

  async function handleShare() {
    setSharing(true);
    setShareMessage(null);
    sound.play("click");
    try {
      const { challenge } = await createChallenge(quiz.configuration);
      const url = `${publicOrigin()}/challenge/${challenge.publicId}`;
      const data = {
        title: "Football IQ",
        text: `קיבלתי ${score.points}/${score.total} ב-Football IQ. מוכנים להתמודד?`,
        url,
      };
      if (navigator.share) await navigator.share(data);
      else {
        await navigator.clipboard.writeText(url);
        setShareMessage("הקישור הועתק.");
      }
    } catch (e) {
      setShareMessage(messageHeOf(e, "לא הצלחנו ליצור קישור, נסו שוב."));
    } finally {
      setSharing(false);
    }
  }

  const stats = [
    { value: score.correct, label: "נכונות", cls: "green" },
    { value: score.incorrect, label: "שגויות", cls: "red" },
    ...(score.revealed > 0 ? [{ value: score.revealed, label: "נחשפו", cls: "amber" }] : []),
    { value: `${score.accuracy}%`, label: "דיוק", cls: "" },
  ];

  return (
    <div className="page results">
      <Confetti active={score.footballIq >= 75} />

      <div className="res-top a-pop">
        <ScoreRing value={score.footballIq} label={score.rank} />
        <p className="res-rank">{score.rank}</p>
        <p className="res-score num" dir="ltr">
          {score.correct}<span className="faint">/{score.total}</span>
        </p>
        <div className="res-meta">
          <span className="tag">
            <Icon name="clock" size={12} /> {mmss(durationSeconds)}
          </span>
          {score.bestStreak >= 2 && (
            <span className="tag tag-amber">
              <FlameMark size={11} /> {score.bestStreak} ברצף
            </span>
          )}
        </div>
      </div>

      <dl className="res-stats a-stagger">
        {stats.map((stat, i) => (
          <div className="res-stat" key={stat.label} style={{ "--i": i } as React.CSSProperties}>
            <dt className={`res-stat-value num ${stat.cls}`}>{stat.value}</dt>
            <dd className="res-stat-label">{stat.label}</dd>
          </div>
        ))}
      </dl>

      {breakdown.length > 0 && (
        <section className="res-cats" aria-label="פילוח לפי קטגוריה">
          {breakdown.map(([cat, s], i) => {
            const pct = Math.round((s.correct / s.total) * 100);
            return (
              <div className="res-cat" key={cat}>
                <span className="res-cat-name">{CATEGORY_LABELS[cat] ?? cat}</span>
                <span className="bar res-cat-bar" aria-hidden="true">
                  <span
                    className="bar-fill"
                    style={{ width: `${pct}%`, transitionDelay: `${i * 60}ms` }}
                  />
                </span>
                <span className="res-cat-count num">
                  {s.correct}/{s.total}
                </span>
              </div>
            );
          })}
        </section>
      )}

      <div className="res-actions">
        <button className="btn btn-primary btn-block" disabled={replaying} onClick={handleReplay}>
          <Icon name="replay" size={17} />
          {replaying ? "טוען…" : "סבב נוסף"}
        </button>
        <div className="res-actions-row">
          <button className="btn btn-ghost" disabled={sharing} onClick={handleShare}>
            <Icon name="share" size={16} />
            {sharing ? "יוצר…" : "אתגרו חברים"}
          </button>
          <button className="btn btn-ghost" onClick={() => navigate("/build")}>
            <Icon name="sliders" size={16} />
            חידון חדש
          </button>
        </div>
        <p className="res-msg" role="status">
          {shareMessage ?? ""}
        </p>
      </div>
    </div>
  );
}
