import { Link } from "react-router-dom";
import { openPrivacySettings } from "../components/PrivacyGate";
import { Icon } from "../components/Icon";
import "./PrivacyPage.css";

/**
 * The full disclosure.
 *
 * Every row below is checkable against `lib/privacy.ts` — these are the exact
 * keys the app writes, and nothing else. The Google Fonts request is listed
 * rather than glossed over, because "no third parties" would not be true.
 */
export function PrivacyPage() {
  return (
    <div className="page policy">
      <header className="policy-head">
        <p className="tiny">מסמך</p>
        <h1 className="policy-title">פרטיות</h1>
        <p className="policy-lede">
          Football IQ הוא משחק חידונים. אפשר לשחק בלי חשבון, ואז אין לנו דרך לדעת מי אתם. באפליקציית
          iOS אפשר גם, אם רוצים, לפתוח חשבון עם Apple. הדף הזה מפרט בדיוק מה נשמר בכל מקרה.
        </p>
      </header>

      <div className="policy-body">
        <Clause title="מה אנחנו לא עושים">
          <ul className="policy-list">
            <li>לא מציבים קובצי Cookie. אף אחד.</li>
            <li>לא מריצים אנליטיקס — לא Google Analytics ולא חלופה.</li>
            <li>לא מציגים פרסומות ולא משתמשים במזהי פרסום.</li>
            <li>לא מבקשים אימייל, טלפון או כל פרט מזהה — גם לא כשפותחים חשבון.</li>
            <li>לא מוכרים ולא משתפים נתונים, כי אין מה למכור.</li>
          </ul>
        </Clause>

        <Clause title="מה נשמר בדפדפן שלכם">
          <p>
            כל מה שהמשחק זוכר נשמר אצלכם מקומית, לא אצלנו. אפשר לכבות את הקטגוריות האופציונליות או
            למחוק הכול בכל רגע.
          </p>
          <div className="policy-table">
            <Row k="fiq_active_quiz" scope="session" why="החידון שאתם משחקים כרגע, כדי שרענון לא יאבד אותו" cat="הכרחי" />
            <Row k="fiq_last_result" scope="session" why="התוצאה האחרונה, כדי להציג את מסך הסיכום" cat="הכרחי" />
            <Row k="fiq_privacy_v1" scope="local" why="הבחירה שלכם בדף הזה, כדי שלא נשאל בכל כניסה" cat="הכרחי" />
            <Row k="fiq_sound_enabled" scope="local" why="אם הצלילים דלוקים או כבויים" cat="העדפות" />
            <Row k="fiq_a11y_v1" scope="local" why="הגדרות הנגישות: גודל טקסט, ניגודיות, אנימציות, קישורים" cat="העדפות" />
            <Row k="fiq_account_token" scope="local" why="ההתחברות לחשבון (Sign in with Apple), כדי שתישארו מחוברים. נמחק בהתנתקות" cat="הכרחי" />
            <Row k="fiq_mp_token" scope="session" why="מזהה זמני לחדר רב משתתפים, כדי שרענון או נפילת רשת יחזירו אתכם לאותו מקום עם אותו ניקוד" cat="הכרחי" />
            <Row k="fiq_mp_name" scope="local" why="השם שבחרתם לרב משתתפים, כדי לא להקליד אותו כל פעם" cat="העדפות" />
            <Row k="fiq_recent_questions" scope="local" why="מזהים של שאלות שראיתם, כדי להעדיף שאלות חדשות" cat="היסטוריה" />
            <Row k="fiq_mp_stats" scope="local" why="ספירה מקומית של משחקי רב משתתפים, נצחונות והפסדים" cat="היסטוריה" />
          </div>
          <p className="policy-note">
            כל מה שב-<code>sessionStorage</code> נמחק לבד כשסוגרים את הכרטיסייה.
          </p>
        </Clause>

        <Clause title="מה נשמר בשרת">
          <p>
            כשמסיימים חידון נרשמת שורה אנונימית: מספר השאלות, כמה נכונות, כמה זמן זה לקח ואיזו תצורה
            שיחקתם. אין בה כתובת IP, אין מזהה דפדפן ואין שום דבר שמחבר בין שתי הרצות שלכם.
          </p>
          <p>
            קישור אתגר שאתם מייצרים נשמר כדי שהחברים שלכם יקבלו את אותן שאלות. הוא מכיל את תצורת
            החידון, לא אתכם.
          </p>
          <p>
            ברב משתתפים, חדר פעיל כולו יושב בזיכרון זמני ולא נכתב לבסיס הנתונים. כשמשחק נגמר נשמרת
            שורה אחת לכל משחק ושורה אחת לכל שחקן — השם שבחרתם לאותו משחק, הניקוד והמקום. השם הזה הוא
            מה שהקלדתם, לא זהות; חדר שנסגר נמחק לגמרי.
          </p>
        </Clause>

        <Clause title="חשבון (רשות, באפליקציית iOS)">
          <p>
            חשבון נפתח עם Sign in with Apple, ולא מבקשים ממנה לא אימייל ולא שם. אצלנו נשמרים רק: מזהה
            אנונימי ש-Apple נותנת לאפליקציה הזו בלבד, השם שבחרתם בעצמכם, והסטטיסטיקה שלכם — מספר
            חידונים, ניקוד שיא וממוצע, ניצחונות והפסדים בדו־קרבות ורצף התשובות הארוך ביותר. החידונים
            והמשחקים שתשחקו בזמן שאתם מחוברים משויכים לחשבון.
          </p>
          <p>
            מחיקת החשבון נמצאת בעמוד הפרופיל. היא מוחקת לצמיתות את המזהה, השם, הסטטיסטיקה וכל
            ההתחברויות, מבטלת את הקישור ל-Apple, ומשאירה את שורות המשחק הישנות אנונימיות, בלי בעלים.
          </p>
        </Clause>

        <Clause title="צדדים שלישיים">
          <p>
            הגופנים (Rubik ו-Assistant) נטענים מ-Google Fonts, ולכן כתובת ה-IP שלכם נחשפת אליהם
            בטעינת הדף. זה הצד השלישי היחיד, והוא מוזכר כאן כי &rdquo;אפס צדדים שלישיים&ldquo; לא
            היה נכון. האפליקציה מתארחת ב-Cloudflare Workers, שמעבדת את הבקשות כספקית תשתית. מי שפותח
            חשבון מתחבר דרך Apple, שמאמתת את הזהות בצד שלה ומעבירה לנו רק את המזהה האנונימי.
          </p>
        </Clause>

        <Clause title="השליטה שלכם">
          <p>
            אפשר לשנות קטגוריות או למחוק כל מה שנשמר מקומית. המחיקה מיידית ומלאה — כולל רשומת
            ההסכמה עצמה, כך שתישאלו מחדש בפעם הבאה.
          </p>
          <div className="policy-actions">
            <button className="btn btn-primary" onClick={openPrivacySettings}>
              <Icon name="sliders" size={16} />
              הגדרות נתונים
            </button>
            <Link to="/" className="btn btn-ghost">
              חזרה למשחק
            </Link>
          </div>
        </Clause>
      </div>
    </div>
  );
}

function Clause({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="policy-clause">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Row({ k, scope, why, cat }: { k: string; scope: string; why: string; cat: string }) {
  return (
    <div className="policy-row">
      <code className="policy-key">{k}</code>
      <span className="tag">{scope}</span>
      <span className="policy-why">{why}</span>
      <span className="policy-cat">{cat}</span>
    </div>
  );
}
