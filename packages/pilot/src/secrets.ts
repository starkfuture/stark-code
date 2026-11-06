/**
 * Credential exclusion for anything that leaves the laptop (snapshot tarball, diffs, hook payload excerpts).
 * Two layers: path-level exclusion (whole file never uploaded) and content-level redaction
 * (matched value replaced, surrounding code kept so the reviewer can still read the logic).
 */

const DENY_PATHS: Array<[RegExp, string]> = [
  [/(^|\/)\.env(\.(?!example$|sample$|template$)[^/]*)?$/i, "env file"],
  [/\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc|crt|cer)$/i, "key/cert material"],
  [/(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/, "ssh key"],
  [/(^|\/)\.(npmrc|yarnrc\.yml|pypirc|netrc|pgpass|git-credentials|dockercfg|htpasswd)$/i, "credential config"],
  [/(^|\/)\.(aws|ssh|gnupg|docker|kube|azure|gcloud)\//, "credential directory"],
  [/(^|\/)(credentials|secrets?|service-account[^/]*)(\.[a-z0-9]+)?$/i, "credentials file"],
  [/(^|\/)\.?(secrets?|credentials?|private-keys?|vault)\//i, "secrets directory"],
  [/(^|\/)[^/]*(secret|token|passw(or)?d|credential|api[-_]?key)[^/]*\.(txt|json|ya?ml|ini|cfg|conf|properties|env|toml|csv)$/i, "credential-like file"],
  [/(^|\/)terraform\.tfstate(\.backup)?$/i, "terraform state"],
  [/(^|\/)\.(lookout|pilot)\//, "pilot local state"],
  [/(^|\/)\.claude\/settings\.local\.json$/, "local Claude Code settings"],
  [/(^|\/)(node_modules|\.git|dist|build|coverage|\.next|\.turbo|\.venv|venv|__pycache__|target)\//, "generated/vendor"],
  [/\.(sqlite3?|db|db-wal|db-shm)$/i, "database file"],
];

/** Glob (`*` within a segment, `**` across segments) to a path regex. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.trim().replace(/^\.\//, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      re += ".*";
      i++;
      if (g[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`(^|/)${re}(/|$)`);
}

import { setting } from "./home.ts";

let extra: { raw: string; res: RegExp[] } | null = null;
/** Extra exclusions from config "snapshot_exclude" (comma list of globs), e.g. "notes/**,*.local.md". */
function configured(): RegExp[] {
  const raw = setting("PILOT_SNAPSHOT_EXCLUDE") ?? "";
  if (!extra || extra.raw !== raw) extra = { raw, res: raw.split(",").map((s) => s.trim()).filter(Boolean).map(globToRegExp) };
  return extra.res;
}

export function deniedPathReason(relPath: string): string | null {
  for (const [re, reason] of DENY_PATHS) if (re.test(relPath)) return reason;
  if (configured().some((re) => re.test(relPath))) return "excluded by snapshot_exclude";
  return null;
}

type Rule = { re: RegExp; kind: string; replace: (m: string, ...g: string[]) => string };

const mask = (kind: string) => `[REDACTED:${kind}]`;

const RULES: Rule[] = [
  {
    // Also matches a key cut off before its END line (truncated logs/previews).
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    kind: "private-key",
    replace: () => mask("private-key"),
  },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, kind: "aws-key-id", replace: () => mask("aws-key-id") },
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, kind: "anthropic-key", replace: () => mask("anthropic-key") },
  { re: /\bsk-(?:live|test|proj)?[-_]?[A-Za-z0-9]{24,}\b/g, kind: "api-key", replace: () => mask("api-key") },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, kind: "github-token", replace: () => mask("github-token") },
  { re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, kind: "github-token", replace: () => mask("github-token") },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, kind: "slack-token", replace: () => mask("slack-token") },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, kind: "google-key", replace: () => mask("google-key") },
  {
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    kind: "jwt",
    replace: () => mask("jwt"),
  },
  {
    // key = "literal", key: 'literal', "key": "literal" (JSON) for secret-ish names; keeps the key, masks the value.
    re: /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key|access[_-]?key|credential)[A-Za-z0-9_]*['"]?\s*[:=]\s*)(['"`])([^'"`\s]{8,})\2/gi,
    kind: "assigned-secret",
    replace: (_m, prefix, q) => `${prefix}${q}${mask("assigned-secret")}${q}`,
  },
  {
    // Unquoted env/yaml/ini values: SECRET_KEY=abc..., password: abc... (not process.env.X, ${VAR} or $VAR).
    re: /^(\s*(?:export\s+)?[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key|access[_-]?key|credential)[A-Za-z0-9_.-]*\s*[:=]\s*)(?!process\.env|os\.environ|\$\{|\$[A-Z_])([A-Za-z0-9_\-+/=.~]{8,})\s*$/gim,
    kind: "assigned-secret",
    replace: (_m, prefix) => `${prefix}${mask("assigned-secret")}`,
  },
  {
    re: /(\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^:\s/@]+:)([^@\s]+)(@)/gi,
    kind: "url-password",
    replace: (_m, a, _pw, at) => `${a}${mask("url-password")}${at}`,
  },
];

export interface RedactResult {
  text: string;
  hits: string[];
}

export function redact(text: string): RedactResult {
  const hits: string[] = [];
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, (...args: unknown[]) => {
      hits.push(rule.kind);
      const groups = args.slice(1, -2).map((g) => (g === undefined ? "" : String(g)));
      return rule.replace(String(args[0]), ...groups);
    });
  }
  return { text: out, hits };
}
