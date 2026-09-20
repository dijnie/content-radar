import { useEffect, useState } from "react";
import type { Story, StoryAction } from "../types";
import { StoryCard } from "./story-card";

const WIDE = "(min-width: 901px)";

function useColumnCount(): number {
  const [wide, setWide] = useState(() => typeof window.matchMedia !== "function" || window.matchMedia(WIDE).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(WIDE);
    const onChange = () => setWide(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return wide ? 2 : 1;
}

interface Props {
  stories: Story[];
  timeZone: string;
  onAction: (story: Story, action: StoryAction) => void;
}

/**
 * Independent columns, as in the reference: a tall card never stretches its
 * neighbour's row. On a narrow screen there is one column, so cards keep their
 * ranked order instead of listing one column after the other.
 */
export function StoryGrid({ stories, timeZone, onAction }: Props) {
  const columns = useColumnCount();
  return (
    <div className="grid" data-columns={columns}>
      {Array.from({ length: columns }, (_, column) => (
        <div className="grid-column" key={column}>
          {stories.filter((_, index) => index % columns === column).map((story) => <StoryCard key={story.id} story={story} timeZone={timeZone} onAction={onAction} />)}
        </div>
      ))}
    </div>
  );
}
