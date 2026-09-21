import { useEffect, useId, useRef, useState } from "react";
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
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
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
        <div className="link-menu" ref={menu} onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
        }}>
          <button ref={trigger} type="button" className="button" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((value) => !value)}>
            Link
          </button>
          {open && (
            <ul id={listId} className="link-list" aria-label="Original sources">
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
