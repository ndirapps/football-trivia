import { useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { accountsAvailable, useAccount } from "../lib/account";
import { sound } from "../lib/sound";
import { AccountSheet } from "./AccountSheet";
import { Icon } from "./Icon";

/**
 * The header's way into an account. Guest: a person icon that opens the
 * invitation. Signed in: the first letter of the name, straight to the profile.
 * Renders nothing where accounts do not exist yet (the web, Android).
 */
export function AccountButton() {
  const account = useAccount();
  const navigate = useNavigate();
  const [sheetOpen, setSheetOpen] = useState(false);

  if (!accountsAvailable()) return null;

  const signedIn = account.status === "signed-in";
  const initial = signedIn ? Array.from(account.user.displayName.trim())[0] ?? "" : "";

  return (
    <>
      <button
        type="button"
        className={`icon-btn account-btn${signedIn ? " is-signed-in" : ""}`}
        aria-label={signedIn ? "הפרופיל שלי" : "התחברות לחשבון"}
        title={signedIn ? "הפרופיל שלי" : "התחברות לחשבון"}
        onClick={() => {
          sound.play("click");
          if (signedIn || account.status === "loading") navigate("/profile");
          else setSheetOpen(true);
        }}
      >
        {signedIn && initial ? <span className="account-btn-initial">{initial}</span> : <Icon name="user" size={18} />}
      </button>
      {/* Portalled out of the header: its backdrop-filter makes it the
          containing block for fixed descendants, which would trap the sheet
          inside the 58px bar. Into #root, not <body>: the boot watchdog in
          index.html treats a screen whose middle is not #root as a collapsed
          app, and would raise the recovery screen over an open sheet. */}
      {sheetOpen && createPortal(<AccountSheet onDismiss={() => setSheetOpen(false)} />, document.getElementById("root") ?? document.body)}
    </>
  );
}
