import type { Story, StoryAction } from "../types";
import { StoryCard } from "./story-card";

interface Props {
  stories: Story[];
  timeZone: string;
  onAction: (story: Story, action: StoryAction) => void;
}

/** Row order is also reading and keyboard order, at every viewport width. */
export function StoryGrid({ stories, timeZone, onAction }: Props) {
  return (
    <div className="grid">
      {stories.map((story) => <StoryCard key={story.id} story={story} timeZone={timeZone} onAction={onAction} />)}
    </div>
  );
}
