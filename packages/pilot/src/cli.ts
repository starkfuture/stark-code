/**
 * Pilot CLI. `hook` and `deliver` are hot paths (called by Claude Code on every relevant event), so modules
 * are imported lazily per command.
 */
import { parseArgs } from "node:util";

const HELP = `Pilot - it watches what you ask your Claude Code sessions and tells you when you're forgetting something

It reads your prompts across the sessions of the Claude Code profiles you choose and, in a chat, points out a
rule you wrote, something you said earlier, a question still waiting on you, a missing detail or a hard-to-undo
step, always with the exact quote. It stays silent otherwise. Reviewing finished work is optional (review_work).

Setup
  pilot install [--profile <dir>]   install the Pilot plugin into a Claude Code profile (default ~/.claude)
  pilot selftest [--model m]        verify the investigator's isolation with a real "claude -p" run
  pilot doctor                      check node, git, claude, profiles, daemon, self-test
  pilot config                      effective settings and where they come from

Work review inbox (review_work; all watched repositories; refs look like orders-service#3)
  pilot inbox [--all] [--repo <r>]  open findings, and whether Pilot told the session or kept quiet (and why)
  pilot show <ref>                  evidence, grounding checks, uncertainty, history
  pilot accept|dismiss|defer <ref> -m <reason> [--until <ISO date>]
  pilot reopen <ref>
  pilot handoff <ref>               ready-to-paste prompt for the coding agent (Pilot never edits your repo)

Control
  pilot status | repos | runs [--repo <r>]
  pilot pause | resume [--repo <r>] stop/start launching reviews (events keep being captured)
  pilot start | stop [--interrupt]  the background daemon (normally started by the first Claude Code session)
  pilot budget [set <cents>]        rolling 24 h budget across all repositories
  pilot assess [--deep] [--repo <r>] review the current working tree now
  pilot onboard --goal <t|@file> [--requirement <t>]... [--constraint <t>]... [--approach <t|@file>] [--repo <r>]
                                      optional: record a project goal and run a two-phase baseline review

Chat (prompt watching: Pilot reads your prompts and speaks up when you're about to forget something)
  pilot chat                        the thread: Pilot's nudges, your questions and its answers
  pilot ask [--engine claude|codex] "<question>"
                                      ask about your own sessions ("what's waiting on me?"); --engine for this one question

Agent Engine (production monitoring)
  pilot engine connect [--url <u>]  store an engine API key (hidden prompt, or stdin) in the macOS Keychain
  pilot engine status               connection, last poll, last error, stored findings and who was told
  pilot engine disconnect           remove the key from the Keychain and stop polling

Apps
  pilot api <method> [flags]        JSON interface (status, chat, ask, nudge, settings, findings, activity, production, decide, pause, resume); see README

Development
  pilot daemon [--until-idle]       run the daemon in the foreground
  pilot watch [--until-idle] --repo <path>   schedule one repository in the foreground
  pilot deliver [--repo <r>]        preview what would be said to a session now
Internal (Claude Code hooks): pilot hook [--repo <path>] · pilot deliver --context|--rewake`;

/** What `pilot setup` uses of the live (Managed Agents) investigator. */
interface ManagedSetup {
  setup(log: (m: string) => void): Promise<{ agentId: string; agentVersion: number; environmentId: string }>;
}

/**
 * Live mode (hosted Managed Agents) is the only path that needs a package outside Node: @anthropic-ai/sdk. The plugin
 * copy that Claude Code runs ships without node_modules, so the module is loaded by URL at run time (the package
 * typecheck leaves it out) and a missing SDK is reported in plain words.
 */
async function loadManagedInvestigator(): Promise<new (cfg: import("./config.ts").Config, db: import("./db.ts").DB) => import("./investigator/index.ts").Investigator & ManagedSetup> {
  try {
    return (await import(new URL("./investigator/managed.ts", import.meta.url).href)).ManagedInvestigator;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ERR_MODULE_NOT_FOUND") throw err;
    throw new Error('live mode needs @anthropic-ai/sdk 1.4, which this copy of Pilot does not include. Use mode "local" (the default), or run Pilot from a checkout that has the SDK installed.');
  }
}

function readArg(v: string | undefined, fs: typeof import("node:fs")): string {
  if (!v) return "";
  return v.startsWith("@") ? fs.readFileSync(v.slice(1), "utf8").trim() : v;
}

async function main(): Promise<void> {
  if (process.argv[2] === "api") {
    // JSON interface for apps. It parses its own flags, so even bad flags are answered with one JSON object.
    try {
      const { runApi } = await import("./api.ts");
      process.exitCode = await runApi(process.argv.slice(3));
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ api: 1, error: String((err as Error)?.message ?? err) })}\n`);
      process.exitCode = 1;
    }
    return;
  }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      profile: { type: "string" },
      m: { type: "string", short: "m" },
      until: { type: "string" },
      deep: { type: "boolean" },
      all: { type: "boolean" },
      "until-idle": { type: "boolean" },
      interrupt: { type: "boolean" },
      goal: { type: "string" },
      requirement: { type: "string", multiple: true },
      constraint: { type: "string", multiple: true },
      approach: { type: "string" },
      model: { type: "string" },
      rewake: { type: "boolean" },
      context: { type: "boolean" },
      tool: { type: "boolean" },
      "no-assess": { type: "boolean" },
      url: { type: "string" },
      engine: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const cmd = positionals[0] ?? "help";

  if (cmd === "hook") {
    const { runHook } = await import("./hook.ts");
    await runHook(values.repo);
    return;
  }
  if (cmd === "deliver" && values.tool) {
    // Tool hooks (hot path, every tool call while a nudge is queued): never throws into Claude Code.
    try {
      const { runToolDeliver } = await import("./toolDeliver.ts");
      process.exitCode = await runToolDeliver();
    } catch {
      process.exitCode = 0;
    }
    return;
  }
  if (cmd === "deliver" && (values.rewake || values.context)) {
    // Hook path: never throws into Claude Code.
    try {
      const { loadEnv } = await import("./config.ts");
      loadEnv();
      const { runDeliver } = await import("./deliver.ts");
      process.exitCode = await runDeliver(values.rewake ? "rewake" : "context", { repo: values.repo });
    } catch {
      process.exitCode = 0;
    }
    return;
  }
  if (cmd === "help" || values.help) {
    console.log(HELP);
    return;
  }

  const fs = await import("node:fs");
  const path = await import("node:path");
  const { loadConfig, loadEnv, hasAnthropicCredentials, TOOL_ROOT } = await import("./config.ts");
  const { openDb, kvGet, kvSet } = await import("./db.ts");
  const home = await import("./home.ts");
  loadEnv();
  const reg = home.openRegistry();

  /** --repo (path, name or key) > a registered repo containing the cwd > the cwd's git working tree. */
  const repoRoot = (ref = values.repo): string => {
    if (ref) {
      const hit = home.findRepo(reg, ref);
      if (hit) return hit.root;
      if (fs.existsSync(ref)) return home.findRepoRoot(ref) ?? path.resolve(ref);
      throw new Error(`no watched repository "${ref}" (see \`pilot repos\`)`);
    }
    const r = home.findRepoRoot(process.cwd());
    if (!r) throw new Error("not inside a git repository: pass --repo <path|name>");
    return r;
  };
  const ctx = (root = repoRoot()) => {
    const cfg = loadConfig(root, { cheap: true });
    return { root, cfg, db: openDb(cfg.stateDir) };
  };
  /** "orders-service#3", "#3", "3" or a fingerprint (the latter three in the current/--repo repository). */
  const findingRef = (raw = positionals[1] ?? "") => {
    const m = raw.match(/^(?:(.+)#)?#?(\d+)$/);
    if (m) return { ...ctx(repoRoot(m[1] || values.repo)), id: Number(m[2]) };
    const c = ctx();
    const row = raw ? (c.db.prepare("SELECT id FROM findings WHERE fingerprint = ?").get(raw) as { id: number } | undefined) : undefined;
    if (!row) throw new Error(`usage: pilot ${cmd} <repo#id> (got "${raw}")`);
    return { ...c, id: Number(row.id) };
  };

  const createInvestigator = async (cfg: import("./config.ts").Config, db: import("./db.ts").DB, quiet = false) => {
    if (cfg.mode === "local") {
      const { LocalClaudeInvestigator } = await import("./investigator/local.ts");
      if (!LocalClaudeInvestigator.available(cfg.claudeBin)) throw new Error(`local mode runs Claude Code headless, but \`${cfg.claudeBin} --version\` failed. Set claude_bin in ~/.pilot/config.json.`);
      if (!quiet) console.error(`MODE: local - \`${cfg.claudeBin} -p\` on your Claude Code login (sandboxed, code-only). No API key used.`);
      return new LocalClaudeInvestigator(cfg, db);
    }
    if (cfg.mode === "offline") {
      const { OfflineFixtureInvestigator, OFFLINE_LABEL } = await import("./investigator/offline.ts");
      if (!quiet) console.error(`\x1b[33mMODE: OFFLINE - ${OFFLINE_LABEL}. Nothing is sent to Anthropic.\x1b[0m`);
      return new OfflineFixtureInvestigator(cfg);
    }
    if (!hasAnthropicCredentials()) {
      throw new Error("live mode needs an Anthropic API credential (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile). Nothing was run.");
    }
    return new (await loadManagedInvestigator())(cfg, db);
  };

  switch (cmd) {
    case "install": {
      const { execFileSync } = await import("node:child_process");
      const profile = values.profile ? path.resolve(home.expandHome(values.profile)) : null;
      const env = { ...process.env, ...(profile ? { CLAUDE_CONFIG_DIR: profile } : {}) };
      if (!profile) delete env.CLAUDE_CONFIG_DIR;
      const claude = home.envVar("INSTALL_CLAUDE_BIN") || "claude";
      console.log(`installing the Pilot plugin into ${profile ?? "~/.claude"} from ${TOOL_ROOT}`);
      execFileSync(claude, ["plugin", "install", "pilot", "--marketplace", TOOL_ROOT, "--scope", "user"], { env, stdio: "inherit" });
      const watched = home.watchedProfiles();
      const target = home.currentProfile(env);
      if (!watched.includes("*") && !watched.includes(target)) {
        const file = path.join(home.ensureHome(), "config.json");
        const conf = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
        conf.profiles = [...new Set([...(conf.profiles ?? ["~/.claude"]), profile ?? "~/.claude"])];
        fs.writeFileSync(file, `${JSON.stringify(conf, null, 2)}\n`, { mode: 0o600 });
        console.log(`added ${profile} to "profiles" in ${file}`);
      }
      console.log("done. New Claude Code sessions in that profile are watched (restart running ones). Next: `pilot selftest`.");
      return;
    }
    case "config": {
      const c = ctx(home.findRepoRoot(process.cwd()) ?? home.pilotHome());
      const file = path.join(home.pilotHome(), "config.json");
      console.log(
        JSON.stringify(
          {
            config_file: fs.existsSync(file) ? file : `${file} (not created; defaults in use)`,
            profiles: home.watchedProfiles(),
            exclude: (home.setting("PILOT_EXCLUDE") ?? "").split(",").filter(Boolean),
            mode: c.cfg.mode,
            claude_bin: c.cfg.claudeBin,
            prompt_watch: {
              engine: c.cfg.engine,
              engine_fallback: c.cfg.engineFallback,
              prompt_check_model: c.cfg.promptCheckModel,
              prompt_check_effort: c.cfg.promptCheckEffort,
              codex_bin: c.cfg.codexBin,
              codex_model: c.cfg.codexModel,
              codex_daily_runs: c.cfg.codexDailyRuns,
              nudge_min_confidence: c.cfg.nudgeMinConfidence,
              nudge_to_session: c.cfg.nudgeToSession,
              prompt_quiet_ms: c.cfg.promptQuietMs,
            },
            review_work: c.cfg.reviewWork,
            model: c.cfg.model,
            delivery: c.cfg.delivery,
            speak: { min_confidence: c.cfg.speakMinConfidence, spacing_min: c.cfg.speakSpacingMin, max_findings: c.cfg.speakMaxFindings, risk_areas: c.cfg.speakRiskAreas, demote_after_dismissals: c.cfg.demoteAfterDismissals },
            budget: { daily_budget_cents: c.cfg.dailyBudgetCents, run_budget_cents: c.cfg.runBudgetCents, window_hours: c.cfg.budgetWindowHours },
            schedule: { min_run_interval_min: c.cfg.minRunIntervalMin, quiet_ms: c.cfg.quietMs, prompt_review: c.cfg.promptReview, auto_deep: c.cfg.autoDeep },
            daemon: { autostart: c.cfg.autostart, idle_exit_min: c.cfg.daemonIdleExitMin },
            agent_engine: await (async () => {
              const e = (await import("./engine.ts")).engineSettings();
              return { url: e.url, poll_min: e.pollMin, repos: e.repos, ...(e.reposError ? { error: e.reposError } : {}) };
            })(),
            note: "env PILOT_<KEY> (or the older LOOKOUT_<KEY>) overrides config.json <key> (lower_snake), e.g. PILOT_SPEAK_SPACING_MIN / speak_spacing_min",
          },
          null,
          2,
        ),
      );
      return;
    }
    case "doctor": {
      const { execFileSync } = await import("node:child_process");
      const { daemonStatus } = await import("./watcher.ts");
      const ver = (c: string, a: string[]) => {
        try {
          return execFileSync(c, a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n")[0];
        } catch {
          return null;
        }
      };
      const c = ctx(home.findRepoRoot(process.cwd()) ?? home.pilotHome());
      const { selfTestStatus } = await import("./selftest.ts");
      const st = c.cfg.mode === "local" ? selfTestStatus(c.cfg) : { ok: true, reason: "n/a" };
      const ds = daemonStatus();
      const [maj, min] = process.versions.node.split(".").map(Number);
      const plugins = ver("claude", ["plugin", "list"]) === null ? null : (() => {
        try {
          return execFileSync("claude", ["plugin", "list"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        } catch {
          return "";
        }
      })();
      console.log(
        [
          `node        ${process.version}${maj > 22 || (maj === 22 && min >= 18) ? "" : "  NEEDS >= 22.18"}`,
          `git         ${ver("git", ["--version"]) ?? "MISSING"}`,
          `claude      ${ver(c.cfg.claudeBin, ["--version"]) ?? `MISSING (${c.cfg.claudeBin})`}`,
          `plugin      ${plugins === null ? "unknown" : /\bpilot\b/.test(plugins) ? "installed in ~/.claude" : "not installed in ~/.claude (run `pilot install`)"}`,
          `profiles    ${home.watchedProfiles().join(", ")}`,
          `mode        ${c.cfg.mode}${c.cfg.mode === "live" ? ` (credential ${hasAnthropicCredentials() ? "present" : "MISSING"}; values are never read)` : ""}`,
          `self-test   ${st.ok ? "ok" : st.reason}`,
          `daemon      ${ds.running ? `running (pid ${ds.lock?.pid})` : "not running (starts with the next Claude Code session, or `pilot start`)"}`,
          `repos       ${home.listRepos(reg).length} watched`,
          `engine      ${(await import("./engine.ts")).engineStatusLine(reg)}`,
          `home        ${home.pilotHome()}`,
        ].join("\n"),
      );
      return;
    }
    case "selftest":
    case "local-selftest": {
      const c = ctx(home.findRepoRoot(process.cwd()) ?? home.pilotHome());
      const { runLocalSelfTest } = await import("./selftest.ts");
      const rec = await runLocalSelfTest(c.cfg, (m) => console.log(m), values.model ?? "sonnet");
      for (const ch of rec.checks) console.log(`${ch.pass ? "PASS" : "FAIL"}  [${ch.kind}] ${ch.name} - ${ch.detail}`);
      console.log(rec.ok ? `local isolation verified (${rec.claudeVersion}, safe-mode ${rec.safeMode ? "on" : "off"})` : "local isolation NOT verified: local mode will refuse to run");
      process.exitCode = rec.ok ? 0 : 1;
      return;
    }
    case "setup": {
      const c = ctx();
      if (c.cfg.mode !== "live") throw new Error("`setup` creates hosted Managed Agents resources; only live mode needs it.");
      const inv = (await createInvestigator(c.cfg, c.db)) as Awaited<ReturnType<typeof createInvestigator>> & ManagedSetup;
      const ids = await inv.setup((m) => console.log(m));
      console.log(`ready: agent ${ids.agentId} v${ids.agentVersion}, environment ${ids.environmentId}`);
      return;
    }
    case "daemon": {
      const { daemon } = await import("./watcher.ts");
      const { selfTestStatus, runLocalSelfTest } = await import("./selftest.ts");
      let selftestTried = 0;
      let selftestRun: Promise<void> | null = null;
      // Local runs (reviews, prompt checks) refuse to start without a recent isolation self-test: run it once if it
      // is missing or old, at most every 6 hours, never twice at the same time.
      const ensureSelfTest = async (cfg: import("./config.ts").Config): Promise<void> => {
        if (cfg.mode !== "local" || selfTestStatus(cfg).ok) return;
        if (selftestRun) return selftestRun;
        if (Date.now() - selftestTried < 6 * 3600_000) return;
        selftestTried = Date.now();
        selftestRun = (async () => {
          console.log(`self-test needed (${selfTestStatus(cfg).reason}); running it now`);
          const rec = await runLocalSelfTest(cfg, (m) => console.log(m), "sonnet");
          console.log(rec.ok ? "self-test passed" : "self-test FAILED: reviews and prompt checks will not run until `pilot selftest` passes");
        })().finally(() => (selftestRun = null));
        return selftestRun;
      };
      await daemon({
        log: (m) => console.log(m),
        untilIdle: values["until-idle"],
        promptWatch: true,
        ensureSelfTest,
        makeInvestigator: async (cfg, db) => {
          await ensureSelfTest(cfg);
          return createInvestigator(cfg, db, true);
        },
      });
      process.exit(process.exitCode ?? 0);
    }
    case "chat": {
      const { listMessages, unreadCount } = await import("./chat.ts");
      const { renderChat } = await import("./inbox.ts");
      const rows = listMessages(reg, { limit: 30 });
      console.log(rows.length ? renderChat(rows) : "no messages yet: Pilot speaks up here when you're about to forget something.");
      const n = unreadCount(reg);
      if (n) console.log(`\n${n} unread nudge(s). Mark them seen: pilot api nudge --all --action seen`);
      return;
    }
    case "ask": {
      const text = positionals.slice(1).join(" ").trim();
      if (!text) throw new Error('usage: pilot ask "<question>"');
      const { askPilot } = await import("./promptWatch.ts");
      const { renderChat } = await import("./inbox.ts");
      if (values.engine !== undefined && values.engine !== "claude" && values.engine !== "codex") throw new Error("--engine must be claude or codex");
      const r = await askPilot(reg, loadConfig(home.pilotHome(), { cheap: true }), text, { engine: values.engine as "claude" | "codex" | undefined });
      console.log(renderChat([r.answer]));
      return;
    }
    case "start": {
      const { maybeStartDaemon } = await import("./hook.ts");
      const { daemonStatus } = await import("./watcher.ts");
      if (daemonStatus().running) console.log(`already running (pid ${daemonStatus().lock?.pid})`);
      else {
        process.env.PILOT_AUTOSTART = "1";
        home.kvSetReg(reg, "daemon_spawned_at", 0);
        maybeStartDaemon(reg);
        console.log(`started; log: ${path.join(home.pilotHome(), "daemon.log")}`);
      }
      return;
    }
    case "stop": {
      const { daemonStatus, watcherStatus } = await import("./watcher.ts");
      if (values.repo) {
        const c = ctx();
        kvSet(c.db, "stop_requested", { mode: values.interrupt ? "interrupt" : "graceful", at: new Date().toISOString() });
        console.log(watcherStatus(c.db).running ? "stop requested for that repository's foreground watcher." : "no foreground watcher for that repository.");
        return;
      }
      const ds = daemonStatus();
      home.kvSetReg(reg, "daemon_stop", ds.running ? { mode: values.interrupt ? "interrupt" : "graceful", at: new Date().toISOString() } : null);
      console.log(ds.running ? `stop requested; daemon pid ${ds.lock?.pid} exits on its next tick (a new Claude Code session starts it again unless autostart is off).` : "daemon not running.");
      return;
    }
    case "pause":
    case "resume": {
      if (values.repo) kvSet(ctx().db, "paused", cmd === "pause");
      else home.kvSetReg(reg, "paused", cmd === "pause");
      console.log(`${cmd === "pause" ? "paused" : "resumed"}${values.repo ? ` for ${values.repo}` : " for all repositories"}${cmd === "pause" ? ": events are still captured; no new reviews start (running ones finish)." : "."}`);
      return;
    }
    case "watch": {
      const c = ctx();
      home.registerRepo(reg, c.root, null, Date.now());
      const inv = await createInvestigator(c.cfg, c.db);
      const { watch } = await import("./watcher.ts");
      await watch(c.cfg, inv, { untilIdle: values["until-idle"], log: (m) => console.log(m) });
      process.exit(process.exitCode ?? 0);
    }
    case "onboard": {
      const c = ctx();
      const goal = readArg(values.goal, fs);
      if (!goal) throw new Error("--goal is required (text or @file)");
      const { getNotes, saveNotes } = await import("./notes.ts");
      const { enqueueJob } = await import("./scheduler.ts");
      home.registerRepo(reg, c.root, null, Date.now());
      const notes = getNotes(c.db);
      notes.goal = goal;
      const devItems = (xs: string[] | undefined) => (xs ?? []).map((t) => ({ text: readArg(t, fs), source: "developer" as const, status: "confirmed" }));
      notes.requirements = [...notes.requirements.filter((i) => i.source !== "developer"), ...devItems(values.requirement)];
      notes.constraints = [...notes.constraints.filter((i) => i.source !== "developer"), ...devItems(values.constraint)];
      notes.updated_by = "developer (onboard)";
      saveNotes(c.db, notes, null);
      if (values["no-assess"]) {
        console.log("project notes recorded (no onboarding review queued).");
        return;
      }
      const jobId = enqueueJob(c.db, "onboarding", "quick", "onboard", { approach: readArg(values.approach, fs) });
      c.db.prepare("UPDATE events SET consumed = 1, job_id = ? WHERE consumed = 0 AND kind = 'prompt'").run(jobId);
      console.log(`onboarding job #${jobId} queued (phase 1: goal + repository only; phase 2: proposed approach).`);
      return;
    }
    case "assess": {
      const c = ctx();
      const { enqueueJob } = await import("./scheduler.ts");
      home.registerRepo(reg, c.root, null, Date.now());
      const jobId = enqueueJob(c.db, values.deep ? "deep" : "manual", values.deep ? "deep" : "quick", "manual", values.m ? { reason: values.m } : undefined);
      c.db.prepare("UPDATE events SET consumed = 1, job_id = ? WHERE consumed = 0").run(jobId);
      console.log(`job #${jobId} queued (${values.deep ? "deep" : "quick"}) for ${c.root}.`);
      return;
    }
    case "budget": {
      const c = ctx(home.findRepoRoot(process.cwd()) ?? home.listRepos(reg)[0]?.root ?? home.pilotHome());
      const { budgetState, setCap } = await import("./budget.ts");
      if (positionals[1] === "set") {
        const cents = Number(positionals[2]);
        if (!Number.isFinite(cents) || cents < 0) throw new Error("usage: pilot budget set <cents>");
        setCap(c.db, cents);
      }
      console.log(JSON.stringify({ ...budgetState(c.db, c.cfg), window_hours: c.cfg.budgetWindowHours, note: "cents; across all watched repositories; local mode reports an API-equivalent estimate (usage counts against your Claude plan)" }, null, 2));
      return;
    }
    case "repos": {
      const rows = home.listRepos(reg);
      if (!rows.length) console.log("no repositories yet: they appear when a watched Claude Code session edits files in them.");
      for (const r of rows) {
        const db = openDb(path.join(home.pilotHome(), "repos", r.key));
        const open = Number((db.prepare("SELECT COUNT(*) AS n FROM findings WHERE status IN ('open','stale')").get() as { n: number }).n);
        const paused = kvGet<boolean>(db, "paused", false);
        console.log(`${r.name.padEnd(28)} ${String(open).padStart(3)} open  last activity ${new Date(r.last_event_ms).toISOString().slice(0, 16).replace("T", " ")}${paused ? "  PAUSED" : ""}${home.isExcluded(r.root) ? "  EXCLUDED" : ""}\n  ${r.root}`);
      }
      return;
    }
    case "status": {
      const { renderStatus } = await import("./inbox.ts");
      console.log(renderStatus(reg, values.repo ? ctx() : null));
      return;
    }
    case "runs": {
      const { renderRuns } = await import("./inbox.ts");
      console.log(renderRuns(ctx().db));
      return;
    }
    case "inbox": {
      const { renderInbox } = await import("./inbox.ts");
      const { repoRef } = await import("./deliver.ts");
      const here = home.findRepoRoot(process.cwd());
      const roots = values.repo ? [repoRoot()] : home.listRepos(reg).map((r) => r.root).sort((a, b) => Number(b === here) - Number(a === here));
      if (!roots.length) console.log("nothing yet: repositories appear when a watched Claude Code session edits files in them.");
      const out = roots.map((root) => renderInbox(ctx(root).db, !!values.all, root, repoRef(root))).filter(Boolean);
      console.log(out.length ? out.join("\n\n") : "no open findings.");
      return;
    }
    case "show": {
      const { renderFinding } = await import("./inbox.ts");
      const { repoRef } = await import("./deliver.ts");
      const f = findingRef();
      console.log(renderFinding(f.db, f.id, repoRef(f.root)));
      return;
    }
    case "handoff": {
      const { renderHandoff } = await import("./inbox.ts");
      const f = findingRef();
      console.log(renderHandoff(f.db, f.id));
      return;
    }
    case "accept":
    case "dismiss":
    case "defer":
    case "reopen": {
      const { decide } = await import("./findings.ts");
      const f = findingRef();
      const r = decide(f.db, f.root, f.id, cmd, values.m ?? "", values.until);
      console.log(`#${r.id} ${r.status}${r.decision_note ? `: ${r.decision_note}` : ""}`);
      return;
    }
    case "deliver": {
      const { runDeliver } = await import("./deliver.ts");
      process.exitCode = await runDeliver("dry-run", { repo: values.repo ? repoRoot() : undefined });
      return;
    }
    case "engine": {
      const eng = await import("./engine.ts");
      const sub = positionals[1] ?? "status";
      if (positionals.length > 2) throw new Error("usage: pilot engine connect [--url <url>] | status | disconnect (the key is read from a hidden prompt or stdin, never from the command line)");
      if (sub === "connect") {
        if (process.platform !== "darwin") throw new Error("pilot engine connect keeps the key in the macOS Keychain, so it needs macOS");
        const url = eng.normalizeEngineUrl(values.url ?? eng.engineSettings().url);
        const secret = await eng.readSecret(`Agent Engine API key for ${url} (input hidden): `);
        const keychain = eng.macKeychain();
        await eng.connectEngine({ reg, url, secret, keychain });
        console.log(`connected to ${url}. The key is in the macOS Keychain (service "${eng.KEYCHAIN_SERVICE}") and nowhere else.`);
        const r = await eng.pollEngine({ reg, keychain });
        const pollMin = eng.engineSettings().pollMin;
        console.log(r.error ? `first poll failed: ${r.error}` : `first poll: ${r.changed} finding(s) changed in the last 48 h. The daemon polls every ${pollMin} min while it runs.`);
        return;
      }
      if (sub === "disconnect") {
        const r = eng.disconnectEngine({ reg, keychain: eng.macKeychain() });
        if (r.error) console.log(`polling stopped, but ${r.error}: remove it in Keychain Access (service "${eng.KEYCHAIN_SERVICE}").`);
        else console.log(r.url ? `disconnected from ${r.url}; ${r.removed ? "the key was removed from the Keychain" : "no key was in the Keychain"}. Stored findings stay listed.` : "not connected.");
        return;
      }
      if (sub !== "status") throw new Error("usage: pilot engine connect [--url <url>] | status | disconnect");
      const { daemonStatus } = await import("./watcher.ts");
      const { RepoMapper, engineWhy } = await import("./engineSpeech.ts");
      const settings = eng.engineSettings();
      const s = eng.engineSummary(reg);
      const at = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "never");
      const lines = [
        `engine      ${s.connected ? `connected to ${s.url}` : s.url ? `disconnected from ${s.url}` : "not connected (pilot engine connect [--url <url>])"}`,
        `last poll   ${at(s.lastPollAt)} · every ${settings.pollMin} min while the daemon runs (${daemonStatus().running ? "running" : "not running"})`,
        `last error  ${s.lastError ?? "none"}`,
        `findings    ${s.findings} stored · ${s.open.critical + s.open.major} open (${s.open.critical} critical, ${s.open.major} major)`,
        ...(settings.reposError ? [`config      ${settings.reposError}`] : []),
      ];
      const rows = eng.listEngineFindings(reg, 15);
      if (rows.length) {
        const mapper = new RepoMapper(reg, settings.repos);
        lines.push("", "latest (said into a session only when it is changing an affected repository):");
        for (const f of rows) {
          const why = engineWhy(f, mapper.localRepos(f), eng.toldCount(reg, f.id));
          lines.push(`  ${f.id} ${f.level.toUpperCase()} ${f.status} · ${JSON.parse(f.services).join(", ") || "no service"} · ${f.title.slice(0, 100)}`, `     ${at(f.at)} · ${why}`);
        }
      }
      console.log(lines.join("\n"));
      return;
    }
    case "notes": {
      const { getNotes } = await import("./notes.ts");
      console.log(JSON.stringify(getNotes(ctx().db), null, 2));
      return;
    }
    default:
      console.log(HELP);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(`pilot: ${(err as Error).message ?? err}`);
  process.exitCode = 1;
});
