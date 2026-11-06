/**
 * Context budget for a review. A busy turn (for example one session fanning out to 50 subagents) can produce
 * hundreds of edit and test events and a very large diff. Passing all of it to the reviewer costs tokens and
 * lowers quality, so the reviewer gets a compact digest and reads the files it needs from repo/ on demand.
 *
 *  - Requests: the latest few developer prompts (they carry the requirements).
 *  - Claims: the latest coding-agent report per session.
 *  - Edits: one entry per file (how many edits, by which agents), not one per edit.
 *  - Tests: the last run plus the latest failures, with short output tails.
 *  - Activity summary: counts, subagents involved, and what was left out.
 *  - Diff: the most recently edited files first, up to a size cap; the rest is listed with its size.
 * Grounding is unaffected: evidence is still checked against the full event text and the full snapshot.
 */

export const BUDGET = { prompts: 6, promptChars: 4000, reports: 3, files: 60, failedTests: 3, testTailChars: 1500, eventsChars: 40_000, diffChars: 120_000 };

type Ev = Record<string, any> & { kind: string; id: string };

const cut = (s: unknown, n: number) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…[${s.length - n} more chars]` : s);

export function compactEvents(events: Ev[], b = BUDGET): { activity: Record<string, unknown>; events: Ev[] } {
  const prompts = events.filter((e) => e.kind === "prompt");
  const stops = events.filter((e) => e.kind === "stop");
  const edits = events.filter((e) => e.kind === "edit");
  const tests = events.filter((e) => e.kind === "test");

  const keptPrompts = prompts.slice(-b.prompts).map((e) => ({ ...e, prompt: cut(e.prompt, b.promptChars) }));
  const lastReportBySession = new Map<string, Ev>();
  for (const s of stops) lastReportBySession.set(String(s.claude_code_session ?? ""), s);
  const reports = [...lastReportBySession.values()].slice(-b.reports);

  const files = new Map<string, { path: string; edits: number; failed: number; agents: Set<string>; last: Ev }>();
  for (const e of edits) {
    const f = files.get(e.path) ?? { path: e.path, edits: 0, failed: 0, agents: new Set<string>(), last: e };
    f.edits++;
    if (e.failed) f.failed++;
    f.agents.add(e.agent_type ? `${e.agent_type}` : e.agent_id ? "subagent" : "main session");
    f.last = e;
    files.set(e.path, f);
  }
  const byRecent = [...files.values()].sort((a, b2) => String(b2.last.at).localeCompare(String(a.last.at)));
  const fileEntries: Ev[] = byRecent.slice(0, b.files).map((f) => ({
    id: f.last.id,
    at: f.last.at,
    kind: "file_edits",
    label: "files changed in this batch (one entry per file)",
    path: f.path,
    edits: f.edits,
    ...(f.failed ? { failed_edits: f.failed } : {}),
    by: [...f.agents],
    ...(f.last.excluded ? { excluded: f.last.excluded } : f.last.new_preview ? { last_edit_preview: cut(f.last.new_preview, 300) } : {}),
  }));

  const failed = tests.filter((t) => t.status === "failed").slice(-b.failedTests);
  const lastTest = tests.at(-1);
  const keptTests = [...new Set([...failed, ...(lastTest ? [lastTest] : [])])].map((t) => ({ ...t, output_tail: cut(t.output_tail, b.testTailChars) }));

  const agents = new Set(events.map((e) => e.agent_id).filter(Boolean));
  const types: Record<string, number> = {};
  for (const e of edits) if (e.agent_type) types[e.agent_type] = (types[e.agent_type] ?? 0) + 1;
  const activity = {
    edits: edits.length,
    files_changed: files.size,
    subagents_seen: agents.size,
    ...(Object.keys(types).length ? { edits_by_subagent_type: types } : {}),
    test_runs: tests.length,
    failed_test_runs: tests.filter((t) => t.status === "failed").length,
    prompts: prompts.length,
    left_out: {
      older_prompts: Math.max(0, prompts.length - keptPrompts.length),
      older_agent_reports: Math.max(0, stops.length - reports.length),
      files_not_listed: Math.max(0, files.size - fileEntries.length),
      test_runs_not_shown: Math.max(0, tests.length - keptTests.length),
    },
    note: "Compact digest of this batch. Read the files in repo/ for anything you need; diff.patch may also be abridged.",
  };
  let out: Ev[] = ([...keptPrompts, ...reports, ...fileEntries, ...keptTests] as Ev[]).sort((a, b2) => String(a.at ?? "").localeCompare(String(b2.at ?? "")));
  // Still too big (very long prompts or reports): shrink the bulky text fields further.
  if (JSON.stringify(out).length > b.eventsChars) {
    out = out.map((e) => ({ ...e, prompt: cut(e.prompt, 1500), coding_agent_message: cut(e.coding_agent_message, 1500), output_tail: cut(e.output_tail, 600), last_edit_preview: undefined }));
  }
  return { activity, events: out };
}

/** Keep the diff under the cap: most recently edited files first, the rest listed with their size. */
export function capDiff(diff: string, recentFirst: string[], max = BUDGET.diffChars): string {
  if (diff.length <= max) return diff;
  const chunks = diff.split(/(?=^diff --git )/m).filter(Boolean);
  const pathOf = (c: string) => c.match(/^diff --git a\/(.+?) b\//)?.[1] ?? "";
  const rank = (c: string) => {
    const i = recentFirst.indexOf(pathOf(c));
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const ordered = [...chunks].sort((a, b) => rank(a) - rank(b) || a.length - b.length);
  const kept: string[] = [];
  const omitted: string[] = [];
  let size = 0;
  for (const c of ordered) {
    if (size + c.length <= max) {
      kept.push(c);
      size += c.length;
    } else omitted.push(`#   ${pathOf(c) || "(non-file section)"}  (${c.split("\n").length} diff lines)`);
  }
  return `${kept.join("")}\n# diff.patch abridged to ${Math.round(max / 1000)} KB. Not shown here (read the files in repo/ if they matter):\n${omitted.join("\n")}\n`;
}
