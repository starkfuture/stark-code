/**
 * LIVE investigator: Claude Managed Agents (beta, managed-agents-2026-04-01; the SDK adds the header).
 *
 * Control plane (once, `pilot setup`): one Environment (cloud sandbox, limited networking) and one Agent
 * (model, system prompt, toolset, submit_assessment custom tool), IDs stored locally and reused.
 * Data plane (per job): upload the bundle via the Files API, create a Session with a hard `budget`,
 * drive it with sessionDriver, read usage/list cost, delete the uploaded bundle.
 */
import fs from "node:fs";
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import { kvGet, kvSet } from "../db.ts";
import { estimateCents } from "../budget.ts";
import { sha256 } from "../util.ts";
import { BUNDLE_MOUNT, type Investigator, type RunOutcome, type RunSpec } from "./index.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { driveSession, type DriverEvent, type SessionApi, type SessionInfo } from "./sessionDriver.ts";
import { SUBMIT_TOOL, validateSubmission } from "./types.ts";

export interface ManagedIds {
  agentId: string;
  agentVersion: number;
  environmentId: string;
  configHash: string;
}

const cents = (amount: unknown): number | null => {
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n) : null;
};

function agentDefinition(cfg: Config) {
  return {
    name: "lookout-overseer",
    description: "Independent development lookout: assesses a developer's working tree and coding-agent activity for mistaken assumptions, missing requirements, simpler approaches and opportunities.",
    model: { id: cfg.model, effort: cfg.quickEffort },
    system: SYSTEM_PROMPT,
    tools: [
      {
        type: "agent_toolset_20260401" as const,
        default_config: { enabled: true, permission_policy: { type: cfg.permissionPolicy } },
        configs: [
          { name: "web_fetch" as const, enabled: false },
          { name: "web_search" as const, enabled: false },
        ],
      },
      SUBMIT_TOOL,
    ],
    metadata: { app: "lookout", schema: "1" },
  };
}

export class ManagedInvestigator implements Investigator {
  readonly runtime = "live" as const;
  private client: Anthropic;
  private cfg: Config;
  private db: DB;

  constructor(cfg: Config, db: DB) {
    this.cfg = cfg;
    this.db = db;
    this.client = new Anthropic(); // credentials resolved by the SDK (API key, auth token or `ant` profile)
  }

  /** Create or update (new version) the Environment and Agent. Safe to re-run. */
  async setup(log: (m: string) => void): Promise<ManagedIds> {
    const def = agentDefinition(this.cfg);
    const configHash = sha256(JSON.stringify(def)).slice(0, 16);
    const existing = kvGet<ManagedIds | null>(this.db, "managed", null);
    let environmentId = existing?.environmentId;
    if (!environmentId) {
      const env = await this.client.beta.environments.create({
        name: "lookout-sandbox",
        description: "Isolated sandbox for lookout investigations. No credentials; package registries only.",
        config: { type: "cloud", networking: { type: "limited", allow_package_managers: true, allow_mcp_servers: false } },
      });
      environmentId = env.id;
      log(`created environment ${env.id}`);
    }
    let agentId = existing?.agentId;
    let agentVersion = existing?.agentVersion ?? 0;
    if (!agentId) {
      const agent = await this.client.beta.agents.create(def);
      agentId = agent.id;
      agentVersion = agent.version;
      log(`created agent ${agent.id} v${agent.version}`);
    } else if (existing?.configHash !== configHash) {
      const agent = await this.client.beta.agents.update(agentId, { ...def, version: agentVersion });
      agentVersion = agent.version;
      log(`updated agent ${agentId} -> v${agent.version}`);
    } else {
      log(`agent ${agentId} v${agentVersion} up to date`);
    }
    const ids: ManagedIds = { agentId, agentVersion, environmentId, configHash };
    kvSet(this.db, "managed", ids);
    return ids;
  }

  private ids(): ManagedIds {
    const ids = kvGet<ManagedIds | null>(this.db, "managed", null);
    if (!ids) throw new Error("Managed Agents resources not set up for this repo: run `pilot setup` first.");
    return ids;
  }

  sdkApi(): SessionApi {
    const s = this.client.beta.sessions;
    return {
      stream: async (id) => {
        const st = await s.events.stream(id);
        return { iterator: st as unknown as AsyncIterable<DriverEvent>, close: () => st.controller.abort() };
      },
      listEvents: async (id) => {
        const out: DriverEvent[] = [];
        for await (const ev of s.events.list(id, { order: "asc" })) out.push(ev as unknown as DriverEvent);
        return out;
      },
      send: async (id, events) => {
        await s.events.send(id, { events: events as never });
      },
      retrieve: async (id): Promise<SessionInfo> => {
        const ses = await s.retrieve(id);
        return {
          status: ses.status,
          listCostCents: cents(ses.usage?.list_cost?.amount),
          usage: ses.usage as unknown as Record<string, unknown>,
          budgetCents: cents(ses.budget?.max_list_cost?.amount),
        };
      },
    };
  }

  async run(spec: RunSpec): Promise<RunOutcome> {
    const ids = this.ids();
    const api = this.sdkApi();
    let sessionId = spec.existingSessionId;
    if (!sessionId) {
      const file = await this.client.files.upload({
        file: await toFile(fs.createReadStream(spec.bundlePath), "bundle.tgz", { type: "application/gzip" }),
      });
      spec.onUpload(file.id);
      const session = await this.client.beta.sessions.create({
        agent:
          spec.depth === "deep"
            ? { type: "agent_with_overrides", id: ids.agentId, version: ids.agentVersion, model: { id: this.cfg.model, effort: this.cfg.deepEffort } }
            : { type: "agent", id: ids.agentId, version: ids.agentVersion },
        environment_id: ids.environmentId,
        title: spec.title,
        metadata: spec.metadata,
        resources: [{ type: "file", file_id: file.id, mount_path: BUNDLE_MOUNT.replace("/mnt/session/uploads", "") }],
        budget: { type: "limit", max_list_cost: { amount: String(spec.sessionBudgetCents), currency: "USD" } },
      });
      sessionId = session.id;
      spec.onSessionCreated(session.id);
    }
    const consoleUrl = `https://platform.claude.com/workspaces/${this.cfg.workspace}/sessions/${sessionId}`;
    spec.log(`session ${sessionId} - watch live: ${consoleUrl}`);

    const drive = await driveSession(api, sessionId, {
      jobId: spec.jobId,
      phases: spec.phases,
      deadlineMs: spec.deadlineMs,
      shouldStop: spec.shouldStop,
      validate: validateSubmission,
      log: spec.log,
    });

    // The stream's session.usage precedes the final idle; the session object can lag slightly (post-idle race).
    let info: SessionInfo | null = null;
    for (let i = 0; i < 5; i++) {
      try {
        info = await api.retrieve(sessionId);
        if (info.status !== "running") break;
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    const streamCost = cents(drive.lastUsage?.list_cost?.amount);
    const platformCost = Math.max(streamCost ?? -1, info?.listCostCents ?? -1);
    const usage = (info?.usage ?? drive.lastUsage ?? null) as Record<string, unknown> | null;
    if (drive.status === "failed" && (info === null || info.status === "running")) {
      // We lost the session (e.g. reconnect limit) while it may still be working: stop it and book its cap,
      // because it can keep spending up to the session budget after we stop listening.
      try {
        await this.interrupt(sessionId);
      } catch {
        /* best effort */
      }
      return { runtime: "live", sessionId, drive, listCostCents: Math.max(platformCost, spec.sessionBudgetCents), costSource: "platform-upper-bound", usage, consoleUrl };
    }
    if (platformCost >= 0) return { runtime: "live", sessionId, drive, listCostCents: platformCost, costSource: "platform", usage, consoleUrl };
    const est = estimateCents(this.cfg.model, usage as Record<string, any> | null);
    return { runtime: "live", sessionId, drive, listCostCents: est, costSource: est === null ? "none" : "estimate", usage, consoleUrl };
  }

  async findOrphan(jobId: number, repoId: string): Promise<string | null> {
    let n = 0;
    for await (const s of this.client.beta.sessions.list({ limit: 50 })) {
      if (s.metadata?.lookout_job_id === String(jobId) && s.metadata?.lookout_repo === repoId) return s.id;
      if (++n >= 100) break;
    }
    return null;
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.client.beta.sessions.events.send(sessionId, { events: [{ type: "user.interrupt" }] });
  }

  async deleteUploads(fileIds: string[]): Promise<void> {
    for (const id of fileIds) {
      try {
        await this.client.files.delete(id);
      } catch {
        /* already gone */
      }
    }
  }
}
