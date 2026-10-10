// The families of decision Juhandu asks. Each is a lane: its judgments are logged with the lane name, so each lane can be exported and trained as its own model.
import type { YesNoQuestion } from "../judges/judge.ts";
import type { VotedItem } from "../store/store.ts";

export const LANES = ["same_story", "pipe_ask", "wants"] as const;
export type Lane = (typeof LANES)[number];

export function isLane(value: string): value is Lane {
  return (LANES as readonly string[]).includes(value);
}

export const LANE_TITLES: Record<Lane, string> = { same_story: "Same story", pipe_ask: "Pipe questions", wants: "What you want to read" };

export const LANE_NOTES: Record<Lane, string> = {
  same_story: "Whether two items report the same story. Taught by the hosted teacher model Jev, so the result is for this install only.",
  pipe_ask: "The yes or no questions your pipes ask. Taught by the hosted teacher model Jev, so the result is for this install only.",
  wants: "Whether you would want to read an item. Taught by your own votes, so the result can be shared.",
};

/** The model name that asks a typed-decision server for a lane, from a template such as "adapter-{lane}". */
export function laneModel(template: string, lane: string): string {
  return template.replaceAll("{lane}", lane);
}

export const WANTS_QUESTION = "Would this reader want to see this item in their daily briefing?";

function snippet(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 3).trimEnd() + "...";
}

/** The question a trained taste model is asked about one item; the export and any later runtime use build it the same way. */
export function wantsQuestion(item: { title: string; sourceTitle: string; folder: string; text: string }): YesNoQuestion {
  return { question: WANTS_QUESTION, facts: { title: item.title, source: item.sourceTitle, folder: item.folder, text: snippet(item.text, 600) } };
}

export function wantsQuestionFor(voted: VotedItem): YesNoQuestion {
  return wantsQuestion(voted);
}
