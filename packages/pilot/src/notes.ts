/**
 * The lookout's persistent project notes: its own model of the project, separate from any one prompt.
 * Developer-authored items (goal, stated requirements/constraints) are protected: the hosted agent can add
 * and annotate, but cannot silently delete or rewrite them.
 */
import type { DB } from "./db.ts";
import { kvGet, kvSet } from "./db.ts";
import { nowIso } from "./util.ts";

export type Source = "developer" | "repo" | "lookout" | "coding-agent" | "inferred";

export interface NoteItem {
  text: string;
  source: Source;
  status?: string; // requirement: confirmed|proposed|inferred ; assumption: unverified|supported|refuted
  evidence?: string;
}

export interface ProjectNotes {
  goal: string;
  requirements: NoteItem[];
  constraints: NoteItem[];
  proposed_solutions: NoteItem[];
  assumptions: NoteItem[];
  open_questions: NoteItem[];
  evidence_log: NoteItem[];
  updated_at: string;
  updated_by: string;
}

export const emptyNotes = (): ProjectNotes => ({
  goal: "",
  requirements: [],
  constraints: [],
  proposed_solutions: [],
  assumptions: [],
  open_questions: [],
  evidence_log: [],
  updated_at: nowIso(),
  updated_by: "init",
});

export const getNotes = (db: DB): ProjectNotes => ({ ...emptyNotes(), ...kvGet<Partial<ProjectNotes>>(db, "notes", {}) });

export function saveNotes(db: DB, notes: ProjectNotes, jobId: number | null): void {
  kvSet(db, "notes", notes);
  db.prepare("INSERT INTO notes_versions(ts, job_id, notes) VALUES (?, ?, ?)").run(nowIso(), jobId, JSON.stringify(notes));
}

const LIST_KEYS = ["requirements", "constraints", "proposed_solutions", "assumptions", "open_questions", "evidence_log"] as const;
const MAX_ITEMS = 40;

function asItems(v: unknown): NoteItem[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? { text: x, source: "lookout" as Source } : (x as NoteItem)))
    .filter((x) => x && typeof x.text === "string" && x.text.trim())
    .map((x) => ({
      text: x.text.trim().slice(0, 600),
      source: (["developer", "repo", "lookout", "coding-agent", "inferred"].includes(x.source) ? x.source : "lookout") as Source,
      ...(x.status ? { status: String(x.status).slice(0, 40) } : {}),
      ...(x.evidence ? { evidence: String(x.evidence).slice(0, 400) } : {}),
    }));
}

/**
 * Merge the agent's notes update. Lists are replaced by the agent's version (it owns its working model),
 * except developer-sourced items, which are always kept (an agent can only re-label their status).
 */
export function mergeNotes(current: ProjectNotes, update: Record<string, unknown> | undefined, by: string): ProjectNotes {
  if (!update) return current;
  const next: ProjectNotes = { ...current, updated_at: nowIso(), updated_by: by };
  for (const key of LIST_KEYS) {
    if (!(key in update)) continue;
    const proposed = asItems(update[key]).map((i) => (i.source === "developer" ? { ...i, source: "lookout" as Source } : i));
    const dev = current[key].filter((i) => i.source === "developer");
    const devTexts = new Set(dev.map((d) => d.text));
    // Agent may annotate a developer item by repeating its exact text with a status.
    const annotated = dev.map((d) => {
      const match = asItems(update[key]).find((p) => p.text === d.text);
      return match?.status ? { ...d, status: match.status, evidence: match.evidence ?? d.evidence } : d;
    });
    // Cap only the agent's own items; developer obligations are never dropped.
    next[key] = [...annotated, ...proposed.filter((p) => !devTexts.has(p.text)).slice(0, Math.max(0, MAX_ITEMS - annotated.length))];
  }
  return next;
}
