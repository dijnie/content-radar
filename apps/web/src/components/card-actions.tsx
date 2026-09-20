import { useId, useState } from "react";
import type { Story, StoryAction } from "../types";

/** Only http(s) links are ever rendered; anything else is dropped. */
export function safeUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

interface Props {
  story: Story;
  onAction: (action: StoryAction) => void;
}

export function CardActions({ story, onAction }: Props) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const links = story.links.flatMap((link) => {
    const url = safeUrl(link.url);
    return url ? [{ ...link, url }] : [];
  });
  const state = story.userState;

  return (
    <div className="card-actions">
      {links.length === 1 && (
        <a className="button" href={links[0]!.url} target="_blank" rel="noopener noreferrer">
          Link
        </a>
      )}
      {links.length > 1 && (
        <div className="link-menu">
          <button type="button" className="button" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((value) => !value)}>
            Link <span className="count">{links.length}</span>
          </button>
          {open && (
            <ul id={listId} className="link-list">
              {links.map((link) => (
                <li key={link.url}>
                  <a href={link.url} target="_blank" rel="noopener noreferrer">
                    {link.author ?? new URL(link.url).hostname} <span className="count">{link.platform}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {state === "inbox" ? (
        <>
          <button type="button" className="button" onClick={() => onAction("save")}>Save</button>
          <button type="button" className="button" onClick={() => onAction("dismiss")}>Dismiss</button>
        </>
      ) : (
        <button type="button" className="button" onClick={() => onAction("restore")}>Restore</button>
      )}
      {state !== "written" && state !== "dismissed" && (
        <button type="button" className="button" onClick={() => onAction("written")}>Written</button>
      )}
    </div>
  );
}
