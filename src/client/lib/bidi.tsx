import { Fragment, type ReactNode } from "react";

/**
 * Hebrew sentences with Latin names in them ("עבר מ-Borussia Dortmund ל-Bayern")
 * get reordered by the bidi algorithm: the Hebrew prefixes and the names swap
 * places on screen. Wrapping each Latin run in <bdi> isolates it, so the
 * sentence reads in the order it was written.
 */
const LATIN_RUN = /[A-Za-zÀ-ɏ](?:[A-Za-zÀ-ɏ0-9.'’&\- ]*[A-Za-zÀ-ɏ0-9.])?/g;

export function isolateLatin(text: string | null | undefined): ReactNode {
  if (!text) return text ?? "";
  if (!/[֐-׿]/.test(text) || !/[A-Za-zÀ-ɏ]/.test(text)) return text;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(LATIN_RUN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(<bdi key={at}>{m[0]}</bdi>);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <Fragment>{out}</Fragment>;
}

/** Older seeded hints read "השחקן הוא אנגליה"; show them as "השחקן מאנגליה". */
export function hintText(hint: string): string {
  const m = /^השחקן הוא (\S.*)$/.exec(hint.trim());
  return m ? `השחקן מ${m[1]}` : hint;
}
