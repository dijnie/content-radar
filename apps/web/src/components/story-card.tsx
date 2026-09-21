import { useState } from "react";
import type { Story, StoryAction } from "../types";
import { CardActions } from "./card-actions";
import { ClaimLine } from "./claim-line";

/** `11 Sep 2026, 10:03 ICT`. Assembled from parts, because whole-string formats differ between engines ("Sept" versus "Sep"). */
export function formatTime(epochSeconds: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).formatToParts(new Date(epochSeconds * 1000));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  // Indochina Time has no short name in most engines, which print "GMT+7" instead.
  const zone = timeZone === "Asia/Ho_Chi_Minh" ? "ICT" : get("timeZoneName");
  return `${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")} ${zone}`;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

interface Props {
  story: Story;
  timeZone: string;
  onAction: (story: Story, action: StoryAction) => void;
}

export function StoryCard({ story, timeZone, onAction }: Props) {
  const [questionsOpen, setQuestionsOpen] = useState(false);
  const hidden = story.claimCount - story.claims.length;
  return (
    <article className={`card card--${story.status}`} aria-labelledby={`story-${story.id}`}>
      <header className="card-head">
        <span className={`dot dot--${story.status}`} aria-hidden="true" />
        <h2 className="card-label">{story.label ?? "untitled"}</h2>
        <span className={`status status--${story.status}`}>{story.status.toUpperCase()}</span>
        {story.userState === "written" && <span className="chip chip--written">written</span>}
        {!story.alive && <span className="chip chip--muted">no longer active</span>}
        <span className="score" aria-label={`score ${story.score.toFixed(1)}`}>{story.score.toFixed(1)}</span>
      </header>

      <div className="card-body">
        <p className="headline" id={`story-${story.id}`}>{story.headline}</p>
        {story.headlineSource === "fallback" && <span className="chip chip--muted">chưa tổng hợp</span>}
        <ul className="claims">
          {story.claims.map((claim) => <ClaimLine key={claim.claimId} claim={claim} />)}
        </ul>
        {hidden > 0 && <p className="more-claims">+{plural(hidden, "more claim", "more claims")}</p>}
      </div>

      <p className="card-meta">
        <strong className={`sources sources--${story.status}`}>{plural(story.independentSources, "independent source", "independent sources")}</strong>
        <span aria-hidden="true">·</span>
        {story.questions.length > 0 ? (
          <button type="button" className="questions-toggle" aria-expanded={questionsOpen} aria-controls={`questions-${story.id}`} onClick={() => setQuestionsOpen((open) => !open)}>
            {plural(story.questions.length, "question", "questions")} to verify
          </button>
        ) : <span>0 questions to verify</span>}
        {story.hasCounter && <span className="chip chip--counter">counterpoint</span>}
      </p>
      {story.questions.length > 0 && (
        <ol className="questions" id={`questions-${story.id}`} hidden={!questionsOpen}>
          {story.questions.map((question, index) => <li key={index}>{question}</li>)}
        </ol>
      )}

      <footer className="card-foot">
        <time className="time" dateTime={new Date(story.lastClaimAt * 1000).toISOString()}>{formatTime(story.lastClaimAt, timeZone)}</time>
        <CardActions story={story} onAction={(action) => onAction(story, action)} />
      </footer>
    </article>
  );
}
