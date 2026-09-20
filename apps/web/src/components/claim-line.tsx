import type { ClaimLine as Claim } from "../types";

const LABEL: Record<Claim["role"], string> = { evidence: "EVIDENCE", context: "CONTEXT", counter: "COUNTER", unassigned: "CLAIM" };

/** One claim of a card. The text is rendered as text; the verbatim quote is available on hover and to screen readers. */
export function ClaimLine({ claim }: { claim: Claim }) {
  return (
    <li className="claim">
      <span className={`claim-role claim-role--${claim.role}`}>{LABEL[claim.role]}</span>
      <p className="claim-text" title={`“${claim.quote}”${claim.author ? ` — ${claim.author}` : ""} (${claim.platform})`}>
        {claim.textVi}
      </p>
    </li>
  );
}
