// Turns what Juhandu has logged into practice rows for training a local decision model. Each row holds one question asked both ways (answer and inverse),
// the lane it belongs to, and its labels: a person's vote (human), a hosted teacher model's answer (teacher), or a local model's shadow answer (local).
// A row with human labels teaches directly; a row with only a teacher answer is a soft target on the train side and a teacher test label on the test side.
// Nothing here sends anything anywhere.
import { createHash } from "node:crypto";
import { yesNoRequest } from "../judges/systemone.ts";
import type { Store, StoredJudgment } from "../store/store.ts";
import { LANES, LANE_NOTES, LANE_TITLES, isLane, wantsQuestionFor } from "./lanes.ts";
import type { Lane } from "./lanes.ts";

type Answers = Record<string, { type: "noul"; noul: number }>;

export interface TrainingRow {
  id: string;
  lane: Lane;
  ts: string;
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
  teacher?: { answers: Answers };
  local?: { answers: Answers };
  human?: { answer: boolean; inverse: boolean };
  note?: string;
}

export interface ExportOptions {
  lanes?: Lane[];
  /** Private-tier items stay out unless this is set; the export file is then as private as the feeds are. */
  includePrivate?: boolean;
}

export interface LaneSummary {
  lane: Lane;
  title: string;
  note: string;
  /** Rows labelled by a person's vote. */
  human: number;
  humanTrain: number;
  humanTest: number;
  /** Rows labelled only by the hosted teacher model. */
  teacher: number;
  /** Logged questions nobody has labelled (only a local model answered). */
  unlabeled: number;
  /** Whether an adapter can ship: it needs human rows, since rows taught by a hosted model are excluded from a shared adapter. */
  shippable: boolean;
  /** Enough rows to train and to judge a promotion on held-out rows. */
  ready: boolean;
}

export interface TrainingExport {
  rows: TrainingRow[];
  summaries: LaneSummary[];
}

/** The split rule: sha1(id) % 5 == 0 is the test side, so a row stays on the same side in every export. */
export function splitOf(id: string): "train" | "test" {
  return BigInt("0x" + createHash("sha1").update(id).digest("hex")) % 5n === 0n ? "test" : "train";
}

export const MIN_HUMAN_TRAIN = 150;
export const MIN_HUMAN_TEST = 30;

function answersFor(probability: number): Answers {
  const p = Math.min(1, Math.max(0, probability));
  return { answer: { type: "noul", noul: p }, inverse: { type: "noul", noul: 1 - p } };
}

function probabilityOf(output: unknown): number | null {
  const p = (output as { probability?: unknown } | null)?.probability;
  return typeof p === "number" && Number.isFinite(p) ? p : null;
}

function judgmentRows(store: Store, install: string, lane: Lane, includePrivate: boolean): { rows: TrainingRow[]; unlabeled: number } {
  const groups = new Map<string, StoredJudgment[]>();
  for (const j of store.laneJudgments([lane])) {
    if (j.kind !== "yes_no") continue;
    if (j.tier === "private" && !includePrivate) continue;
    const key = createHash("sha1").update(j.question + "\n" + JSON.stringify(j.input)).digest("hex");
    const group = groups.get(key) ?? [];
    group.push(j);
    groups.set(key, group);
  }
  const rows: TrainingRow[] = [];
  let unlabeled = 0;
  for (const group of groups.values()) {
    const latest = (provider: string) => [...group].reverse().find((j) => j.provider === provider && probabilityOf(j.output) !== null);
    const teacher = latest("jev");
    if (!teacher) {
      unlabeled++;
      continue;
    }
    const local = latest("typed");
    const request = yesNoRequest({ question: teacher.question, facts: teacher.input as Record<string, string | number | boolean> });
    rows.push({
      id: `jhd-${install}-${lane}-${teacher.id}`,
      lane,
      ts: teacher.createdAt,
      state: request.state,
      questions: request.questions,
      teacher: { answers: answersFor(probabilityOf(teacher.output) as number) },
      ...(local ? { local: { answers: answersFor(probabilityOf(local.output) as number) } } : {}),
    });
  }
  return { rows, unlabeled };
}

function voteRows(store: Store, install: string, includePrivate: boolean): TrainingRow[] {
  return store
    .votedItems(50_000)
    .filter((v) => includePrivate || v.tier !== "private")
    .map((v) => {
      const request = yesNoRequest(wantsQuestionFor(v));
      return {
        id: `jhd-${install}-wants-${v.id}`,
        lane: "wants",
        ts: v.votedAt,
        state: request.state,
        questions: request.questions,
        human: { answer: v.vote > 0, inverse: v.vote <= 0 },
        ...(v.reason ? { note: v.reason } : {}),
      };
    });
}

export function buildTrainingExport(store: Store, options: ExportOptions = {}): TrainingExport {
  const lanes = options.lanes?.length ? options.lanes : [...LANES];
  const includePrivate = options.includePrivate === true;
  const install = store.installId();
  const rows: TrainingRow[] = [];
  const summaries: LaneSummary[] = [];
  for (const lane of lanes) {
    let laneRows: TrainingRow[];
    let unlabeled = 0;
    if (lane === "wants") laneRows = voteRows(store, install, includePrivate);
    else {
      const built = judgmentRows(store, install, lane, includePrivate);
      laneRows = built.rows;
      unlabeled = built.unlabeled;
    }
    const humanRows = laneRows.filter((r) => r.human);
    const humanTrain = humanRows.filter((r) => splitOf(r.id) === "train").length;
    const humanTest = humanRows.length - humanTrain;
    summaries.push({
      lane,
      title: LANE_TITLES[lane],
      note: LANE_NOTES[lane],
      human: humanRows.length,
      humanTrain,
      humanTest,
      teacher: laneRows.length - humanRows.length,
      unlabeled,
      shippable: humanRows.length > 0,
      ready: humanTrain >= MIN_HUMAN_TRAIN && humanTest >= MIN_HUMAN_TEST,
    });
    rows.push(...laneRows);
  }
  return { rows, summaries };
}

/** Parses a comma list of lanes from a query or command line; an unknown name is an error so a typo never exports nothing quietly. */
export function parseLanes(value: string | null | undefined): Lane[] {
  if (!value) return [];
  const out: Lane[] = [];
  for (const name of value.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!isLane(name)) throw new Error(`Unknown lane "${name}". Lanes are ${LANES.join(", ")}.`);
    out.push(name);
  }
  return out;
}

export function toJsonl(rows: TrainingRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}
