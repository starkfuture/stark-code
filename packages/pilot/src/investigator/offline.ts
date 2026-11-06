/**
 * OFFLINE investigator - clearly labelled, NOT hosted execution.
 *
 * Picks a hand-written fixture (fixtures/offline/*.json) whose match rules fit the job, and replays it
 * through FakeSessionServer + the real sessionDriver. Findings it produces are expected outputs written
 * by a human for the demo repository; they show the pipeline works, not that a model would find them.
 */
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { FakeSessionServer, type FakeScript, type FakeTurn } from "./fakeSession.ts";
import type { Investigator, MatchContext, RunOutcome, RunSpec } from "./index.ts";
import { driveSession } from "./sessionDriver.ts";
import { validateSubmission } from "./types.ts";

export interface FixtureRule {
  source: string; // events | diff | approach | file:<path>
  re: string;
}

export interface Fixture {
  _label: string;
  name: string;
  match: { kinds?: string[]; all?: FixtureRule[]; none?: FixtureRule[] };
  turns: FakeTurn[];
}

export const OFFLINE_LABEL = "OFFLINE FIXTURE (hand-written expected output, not hosted model execution)";

function sourceText(m: MatchContext, source: string): string {
  if (source === "events") return m.eventsText;
  if (source === "diff") return m.diff;
  if (source === "approach") return m.approach;
  if (source.startsWith("file:")) return m.readFile(source.slice(5)) ?? "";
  return "";
}

export function loadFixtures(dir: string): Fixture[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Fixture);
}

export function selectFixture(fixtures: Fixture[], m: MatchContext): Fixture | null {
  const test = (r: FixtureRule) => new RegExp(r.re, "m").test(sourceText(m, r.source));
  return (
    fixtures.find(
      (f) => (!f.match.kinds || f.match.kinds.includes(m.kind)) && (f.match.all ?? []).every(test) && !(f.match.none ?? []).some(test),
    ) ?? null
  );
}

export class OfflineFixtureInvestigator implements Investigator {
  readonly runtime = "offline-fixture" as const;
  private cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  private sessionFile(id: string): string {
    return path.join(this.cfg.stateDir, "offline-sessions", `${id}.json`);
  }

  async run(spec: RunSpec): Promise<RunOutcome> {
    const fixture = selectFixture(loadFixtures(this.cfg.fixturesDir), spec.match);
    const phaseName = spec.kind === "onboarding" ? ["baseline", "comparison"] : ["checkpoint"];
    const turns: FakeTurn[] = fixture
      ? fixture.turns.map((t) => ({ ...t, costCents: Math.round((t.costCents ?? 0) * this.cfg.simulatedCostScale) }))
      : phaseName.map((phase) => ({
          costCents: 0,
          submission: {
            phase,
            summary: `[${OFFLINE_LABEL}] No fixture matches this job; nothing was assessed.`,
            findings: [],
          },
        }));
    const script: FakeScript = { label: fixture?.name ?? "no-fixture", turns, budgetCents: spec.sessionBudgetCents };

    let id = spec.existingSessionId;
    if (!id) {
      id = `sesn_offline_j${spec.jobId}_${Date.now().toString(36)}`;
      spec.onSessionCreated(id);
    }
    const server = new FakeSessionServer({ id, script, file: this.sessionFile(id), stepMs: this.cfg.fakeStepMs });
    spec.log(`[${OFFLINE_LABEL}] fixture=${fixture?.name ?? "(none matched)"} fake session ${id}`);
    const api = server.api();
    const drive = await driveSession(api, id, {
      jobId: spec.jobId,
      phases: spec.phases,
      deadlineMs: spec.deadlineMs,
      shouldStop: spec.shouldStop,
      validate: validateSubmission,
      log: spec.log,
    });
    const info = await api.retrieve(id);
    const simulated = (info.listCostCents ?? 0) > 0;
    return {
      runtime: "offline-fixture",
      sessionId: id,
      drive,
      listCostCents: simulated ? info.listCostCents : null,
      costSource: simulated ? "simulated" : "none",
      usage: info.usage,
      fixture: fixture?.name ?? "none",
    };
  }

  async findOrphan(jobId: number): Promise<string | null> {
    const dir = path.join(this.cfg.stateDir, "offline-sessions");
    if (!fs.existsSync(dir)) return null;
    const f = fs.readdirSync(dir).find((n) => n.startsWith(`sesn_offline_j${jobId}_`) && n.endsWith(".json"));
    return f ? f.replace(/\.json$/, "") : null;
  }

  async interrupt(sessionId: string): Promise<void> {
    const file = this.sessionFile(sessionId);
    if (!fs.existsSync(file)) return;
    await new FakeSessionServer({ id: sessionId, file, stepMs: this.cfg.fakeStepMs }).receive([{ type: "user.interrupt" }]);
  }

  async deleteUploads(): Promise<void> {
    /* nothing uploaded offline */
  }
}
