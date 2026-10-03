/**
 * M16 K20 — the task classifier (plans/k20-task-classifier-proposal.md).
 *
 * Two versions live here, and only here:
 *
 * - **v1** is what routing, K13 and the rules provider read. It is FROZEN:
 *   every task stored before migration 031 carries no label, and telemetry
 *   labels it with v1 at read time. A changed byte in v1 silently re-cohorts
 *   that history.
 * - **v2** is recorded beside v1 at intake, in shadow, and read by nothing.
 *   It follows the K19i floors contract: deterministic rules decide, no model
 *   is ever called, and every answer names the rule that produced it.
 *
 * v2 never produces a label on its own. It confirms v1 or overrides it, and an
 * override always names its rule. Text v2 cannot read (empty, over the cap, not
 * mostly Latin script) leaves v1 standing and is recorded as `unread`.
 */
import type { DecisionAnswer, DecisionQuestion } from "./decision.js";
import type { TaskIntent } from "./scheduler.js";
import type { FloorRule } from "./tool-floors.js";

/** The label set. Changing it invalidates every telemetry cohort; migration 031 CHECKs it. */
export const TASK_KINDS = ["coding", "review", "research", "general"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/**
 * The version whose label `tasks.task_kind` stores. Routing and K13 read v1.
 * Raising this is an activation decision: a stored label is never rewritten,
 * and a cohort never spans versions.
 */
export const CLASSIFIER_VERSION = 1;

/**
 * v1, FROZEN. Byte for byte the regexes that routing, K13 and the rules
 * provider each carried a copy of until K20.
 *
 * `\b` binds only the first and last alternative of each group, so `add`
 * matches "address", `test` matches "latest" and `audit` matches anywhere.
 * That is v1's behaviour and is kept on purpose; v2 is where it is corrected.
 * Pinned label for label over the K20 corpus by
 * `apps/api/test/task-classifier.test.ts`.
 */
export function classifyTaskV1(goal: string): TaskKind {
  const text = goal.toLowerCase();
  if (/\breview|audit|critique\b/.test(text)) return "review";
  if (/\bfix|implement|refactor|add|bug|test|build|migrate\b/.test(text)) return "coding";
  if (/\bresearch|investigate|compare|explain|why\b/.test(text)) return "research";
  return "general";
}

/** Text over this is not read: v1 stands and the row says `unread`. The floors' cap (K19i). */
export const MAX_CLASSIFIER_TEXT_CHARS = 64 * 1024;

/**
 * The rule that decided v2's `kind`.
 *
 * - `explicit-review`, `explicit-change`, `explicit-research`: §4 of the proposal.
 * - `whole-word`: v1's own vocabulary with every alternative anchored on both
 *   sides. It fires only when v1's label rested on part of a word ("address",
 *   "latest", "auditorium"), and answers what the whole-word reading says.
 * - `read-only-intent`: a coding override was vetoed, so v1 stands.
 * - `v1`: no rule fired; v1's label stands.
 * - `unread`: the text was not read; v1's label stands.
 */
export type KindRule =
  | "explicit-review"
  | "explicit-change"
  | "explicit-research"
  | "whole-word"
  | "read-only-intent"
  | "v1"
  | "unread";

export type UnreadReason = "empty" | "over-cap" | "not-latin";

/**
 * The K19i floors whose action makes a task high stakes. Keyed by `FloorRule`,
 * so a floor rename breaks the build here. The patterns below are NOT the
 * floors' patterns: the floors read shell syntax, and a goal is prose. They are
 * a second vocabulary, held to the floors' rule names.
 */
export type HighStakesFloor = Extract<
  FloorRule,
  "publish" | "history-rewrite" | "destructive-sql" | "infra-destroy" | "admin-merge" | "remote-delete"
>;

// Every pattern runs on attacker-sized text and must stay linear: no unbounded
// quantifier is followed by anything that can make it backtrack.
const HIGH_STAKES: ReadonlyArray<readonly [HighStakesFloor, RegExp]> = [
  ["publish", /\bnpm\s+publish\b|\bpublish(?:es|ed|ing)?\b[^\n]{0,80}?\b(?:npm|pypi|crates\.io|rubygems|nuget|registry|package|image|version)\b/],
  ["history-rewrite", /\bforce[- ]?push|\bpush\s+(?:-f|--force)\b|--force-with-lease\b|\brewrit(?:e|es|ing)\s+(?:the\s+)?(?:git\s+)?history\b/],
  ["destructive-sql", /\b(?:drop|truncate|wipe)\s+(?:the\s+)?(?:[\w-]+\s+){0,3}?(?:tables?|databases?|db|schemas?|collections?)\b|\bdelete\s+from\b/],
  ["infra-destroy", /\bterraform\s+(?:apply|destroy)\b|\bkubectl\s+delete\b|\b(?:destroy|tear\s+down)\s+(?:the\s+)?(?:[\w-]+\s+){0,3}?(?:environments?|clusters?|infrastructure|stacks?|namespaces?)\b|\bdeploy(?:s|ed|ing)?\b[^\n]{0,80}?\bto\s+prod(?:uction)?\b/],
  ["admin-merge", /\bmerg(?:e|es|ed|ing)\b[^\n]{0,80}?\badmin\b|--admin\b/],
  ["remote-delete", /\bdelet(?:e|es|ed|ing)\s+(?:the\s+)?(?:[\w./-]+\s+){0,3}?(?:releases?|tags?|remote\s+branch(?:es)?|repo(?:s|sitory|sitories)?)\b|\bpush\s+--delete\b/],
];

// The whole-word groups below are each a SUBSET of the matching v1 group: every
// form begins with, or contains, the v1 alternative it inflects. So `whole-word`
// can only drop a v1 match, never invent one, and whenever `explicit-review`
// fires v1 already says `review`, which an `unread` row keeps.
const REVIEW = /\b(?:review(?:s|ed|ing|ers?)?|audit(?:s|ed|ing|ors?)?|critique)\b/;
const CODING_WORD = /\b(?:fix(?:es|ed|ing)?|implement(?:s|ed|ing)?|refactor(?:s|ed|ing)?|add(?:s|ed|ing)?|bugs?|test(?:s|ed|ing)?|build(?:s|ing)?|migrate)\b/;
const RESEARCH_WORD = /\b(?:research(?:es|ed|ing|ers?)?|investigate[sd]?|compare[sd]?|explain(?:s|ed|ing)?|why)\b/;
const EDIT_VERB =
  /\b(?:fix(?:es|ed|ing)?|implement(?:s|ed|ing)?|refactor(?:s|ed|ing)?|add(?:s|ed|ing)?|migrat(?:e|es|ed|ing)|renam(?:e|es|ed|ing)|replac(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|rewrit(?:e|es|ing)|rewritten|repair(?:s|ed|ing)?|creat(?:e|es|ed|ing)|edit(?:s|ed|ing)?|updat(?:e|es|ed|ing)|bump(?:s|ed|ing)?|port(?:s|ed|ing)?)\b/;
const CODE_OBJECT =
  /\b(?:files?|functions?|tests?|branch(?:es)?|repo(?:s|sitory|sitories)?|modules?|class(?:es)?|methods?|scripts?|migrations?|columns?|endpoints?|parsers?|helpers?|adapters?|config|commits?|code|bugs?)\b|\w\.(?:ts|tsx|js|mjs|cjs|jsx|py|go|rs|java|rb|sql|json|ya?ml|toml|sh|md)\b/;
const RESEARCH =
  /\b(?:research(?:es|ed|ing)?|investigat(?:e|es|ed|ing)|compar(?:e|es|ed|ing)|comparison|explain(?:s|ed|ing)?|why|survey|find\s+out)\b/;
const READ_ONLY =
  /\b(?:do\s+not|don['’]?t|never)\s+(?:modify|edit|change|touch|fix|write)\b|\bread[- ]?only\b|\bno\s+(?:changes|edits|modifications)\b|\bwithout\s+(?:touching|changing|modifying|editing)\b/;
const READ_ONLY_ALL = new RegExp(READ_ONLY.source, "g");

/** v1's three groups read as whole words (inflections v1 also matched allowed). Same precedence as v1. */
function classifyWholeWord(text: string): TaskKind {
  if (REVIEW.test(text)) return "review";
  if (CODING_WORD.test(text)) return "coding";
  if (RESEARCH_WORD.test(text)) return "research";
  return "general";
}

function unreadReason(goal: string, total: number): UnreadReason | undefined {
  if (goal.trim() === "") return "empty";
  if (total > MAX_CLASSIFIER_TEXT_CHARS) return "over-cap";
  const letters = goal.match(/\p{L}/gu)?.length ?? 0;
  const latin = goal.match(/\p{Script=Latin}/gu)?.length ?? 0;
  return latin * 2 < letters ? "not-latin" : undefined;
}

/** What the rules read: the goal, the constraints, and whether a repository is named. */
export type ClassifierIntent = Pick<TaskIntent, "goal" | "repository"> & { constraints?: readonly string[] };

export interface TaskClassificationV2 {
  v1: TaskKind;
  kind: TaskKind;
  rule: KindRule;
  unread?: UnreadReason;
  /** `read-only-intent` fired, whether or not it changed the outcome. */
  readOnly: boolean;
  /** Present only when the intent names a repository. Absent is "no basis", never `false`. */
  needsRepo?: true;
  /** Present only when a high-stakes rule fired. Absent is "no basis", never `false`. */
  highStakes?: HighStakesFloor;
}

/**
 * v2 (shadow). Pure: no model, no I/O, no clock. The kind rules read the goal,
 * as v1 does; `read-only-intent` also reads the constraints.
 */
export function classifyTaskV2(intent: ClassifierIntent): TaskClassificationV2 {
  const v1 = classifyTaskV1(intent.goal);
  const constraints = intent.constraints ?? [];
  const base = { v1, ...(intent.repository ? { needsRepo: true as const } : {}) };
  const total = constraints.reduce((n, c) => n + c.length + 1, intent.goal.length);
  const unread = unreadReason(intent.goal, total);
  if (unread) return { ...base, kind: v1, rule: "unread", unread, readOnly: false };

  const text = intent.goal.toLowerCase();
  const readOnly = READ_ONLY.test([text, ...constraints.map((c) => c.toLowerCase())].join("\n"));
  // An edit verb inside a read-only clause ("do not fix it yet") is not an edit.
  const edits = EDIT_VERB.test(text.replace(READ_ONLY_ALL, " "));
  const highStakes = HIGH_STAKES.find(([, pattern]) => pattern.test(text))?.[0];
  const decide = (kind: TaskKind, rule: KindRule): TaskClassificationV2 => {
    // The veto never assigns a label. It only stops v2 from moving TO coding.
    const vetoed = readOnly && kind === "coding" && v1 !== "coding";
    return {
      ...base,
      kind: vetoed ? v1 : kind,
      rule: vetoed ? "read-only-intent" : rule,
      readOnly,
      ...(highStakes ? { highStakes } : {}),
    };
  };

  if (REVIEW.test(text)) return decide("review", "explicit-review");
  if (edits && CODE_OBJECT.test(text)) return decide("coding", "explicit-change");
  if (!edits && RESEARCH.test(text)) return decide("research", "explicit-research");
  const whole = classifyWholeWord(text);
  return whole !== v1 ? decide(whole, "whole-word") : decide(v1, "v1");
}

/**
 * The K20 battery, recorded at site `task-classifier` on every new task.
 * `kind` is v1 (what routing reads) and `kind_v2` is the shadow answer to the
 * same question. `complexity` and `long_horizon` are asked and never answered:
 * no deterministic rule has a basis for either, so they are absent from every
 * row (the K19a no-basis contract), never `moderate` and never 0.
 */
export const TASK_CLASSIFIER_BATTERY: Record<string, DecisionQuestion> = {
  kind: { kind: "choice", instructions: "What kind of work is this task?", criteria: { coding: null, review: null, research: null, general: null } },
  kind_v2: { kind: "choice", instructions: "The same question as `kind`, answered by classifier v2 (shadow).", criteria: { coding: null, review: null, research: null, general: null } },
  complexity: { kind: "score", instructions: "How large is this task?", criteria: ["trivial", "small", "moderate", "large", "architectural"] },
  needs_repo: { kind: "noul", instructions: "Does this task need a repository?" },
  high_stakes: { kind: "noul", instructions: "Does this task name an action that is hard to undo or reaches past this machine?" },
  long_horizon: { kind: "noul", instructions: "Will this task span many sessions?" },
};

const choice = (value: TaskKind): DecisionAnswer => ({
  kind: "choice",
  value,
  probabilities: Object.fromEntries(TASK_KINDS.map((k) => [k, k === value ? 1 : 0])),
  confidence: 1,
});

/**
 * The answers the rules have a basis for, and the rule behind each. A Noul is
 * only ever 1 or absent: no repository attached is not "needs none", and no
 * high-stakes phrase is not "low stakes".
 */
export function taskClassifierAnswers(intent: ClassifierIntent): {
  answers: Record<string, DecisionAnswer>;
  rules: Record<string, string>;
} {
  const v2 = classifyTaskV2(intent);
  const answers: Record<string, DecisionAnswer> = { kind: choice(v2.v1), kind_v2: choice(v2.kind) };
  const rules: Record<string, string> = { kind_v2: v2.rule };
  if (v2.unread) rules.unread = v2.unread;
  if (v2.needsRepo) {
    answers.needs_repo = { kind: "noul", value: 1 };
    rules.needs_repo = "needs-repo";
  }
  if (v2.highStakes) {
    answers.high_stakes = { kind: "noul", value: 1 };
    rules.high_stakes = v2.highStakes;
  }
  return { answers, rules };
}
