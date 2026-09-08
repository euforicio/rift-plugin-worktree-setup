import { defineRpcContract, type RiftPluginApi } from "@riftlabs/plugin-sdk";
import { z } from "zod";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { DISPATCH, DISPATCH_VERSION, HOOK_NAMES, starterScript, stub } from "./hooks";

/**
 * Worktree Setup
 *
 * A view over the git post-checkout hook that provisions fresh bb worktrees.
 * The hook lives at ~/.githooks/_dispatch; per-repo scripts and logs live
 * under ~/.bb-setup/.
 *
 * The unit is a REPO, not a project: the hook runs with every BB_* variable
 * stripped from its environment, so the only key available at execution time
 * is the worktree's directory name. Keying the UI by repo keeps the UI key
 * and the runtime key identical.
 */

const HOME = homedir();
const SETUP_DIR = path.join(HOME, ".bb-setup");
const LOGS_DIR = path.join(SETUP_DIR, "logs");
const HOOKS_DIR = path.join(HOME, ".githooks");

/** Non-repo bookkeeping scripts that live alongside the per-repo ones. */
const RESERVED = new Set(["sync-hooks"]);

const REPO = z.object({
  /** Disambiguated key: "<name>" or "<name>-<hash8>". Matches the filenames. */
  key: z.string(),
  name: z.string(),
  sourceRoot: z.string().nullable(),
  scriptPath: z.string(),
  hasScript: z.boolean(),
  logPath: z.string(),
  hooksPath: z.string().nullable(),
  /** hooksPath resolves to our dispatcher, so the hook will actually fire. */
  wired: z.boolean(),
  /** A local hooksPath exists but points elsewhere (husky reset it). */
  drifted: z.boolean(),
  /**
   * How to read the drift. "husky" is the churn case husky re-creates on every
   * install; repointing is safe because the dispatcher forwards into it.
   * "foreign" is an unknown owner we flag but never touch on our own.
   */
  driftKind: z.enum(["husky", "foreign"]).nullable(),
  projectIds: z.array(z.string()),
  lastRun: z
    .object({ at: z.string(), outcome: z.enum(["ok", "failed", "unknown"]) })
    .nullable(),
});

export const rpcContract = defineRpcContract({
  listRepos: {
    input: z.null(),
    output: z.object({
      repos: z.array(REPO),
      hooksDir: z.string(),
      globalHooksPath: z.string().nullable(),
      globalWired: z.boolean(),
    }),
  },
  resolveThread: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({
      isWorktree: z.boolean(),
      reason: z.string().nullable(),
      branchName: z.string().nullable(),
      workspacePath: z.string().nullable(),
      repo: REPO.nullable(),
    }),
  },
  readLog: {
    input: z.object({ key: z.string().min(1), maxBytes: z.number().optional() }).strict(),
    output: z.object({ content: z.string(), truncated: z.boolean(), missing: z.boolean() }),
  },
  readScript: {
    input: z.object({ key: z.string().min(1) }).strict(),
    output: z.object({ content: z.string(), sha256: z.string().nullable(), missing: z.boolean() }),
  },
  saveScript: {
    input: z
      .object({
        key: z.string().min(1),
        content: z.string(),
        expectedSha256: z.string().nullable().optional(),
      })
      .strict(),
    output: z.object({
      outcome: z.enum(["written", "conflict"]),
      sha256: z.string().nullable(),
    }),
  },
  repairDrift: {
    input: z.object({ key: z.string().min(1).nullable() }).strict(),
    output: z.object({ repaired: z.array(z.string()), failed: z.array(z.string()) }),
  },
  bootstrapStatus: {
    input: z.null(),
    output: z.object({
      hooksInstalled: z.boolean(),
      hooksStale: z.boolean(),
      globalHooksPath: z.string().nullable(),
      globalWired: z.boolean(),
      /** A global hooksPath pointing somewhere that isn't ours. */
      globalConflict: z.boolean(),
      driftedRepos: z.array(z.string()),
      ready: z.boolean(),
    }),
  },
  bootstrap: {
    input: z.object({ force: z.boolean().optional() }).strict(),
    output: z.object({
      ok: z.boolean(),
      steps: z.array(z.object({ step: z.string(), status: z.enum(["done", "skipped", "failed"]), detail: z.string() })),
    }),
  },
  createScript: {
    input: z.object({ key: z.string().min(1), repoName: z.string().min(1) }).strict(),
    output: z.object({ created: z.boolean(), detail: z.string() }),
  },
});

export default function plugin(bb: RiftPluginApi) {
  const files = () => bb.sdk.files;

  async function readText(p: string): Promise<string | null> {
    try {
      const r = await files().read({ path: p });
      return r.contentEncoding === "base64"
        ? Buffer.from(r.content, "base64").toString("utf8")
        : r.content;
    } catch {
      return null; // missing file is a normal state here, not an error
    }
  }

  /**
   * core.hooksPath out of a git config, without shelling out. Worktree
   * checkouts share the source repo's config file, so callers pass the
   * source root.
   */
  function parseHooksPath(config: string | null): string | null {
    if (!config) return null;
    let inCore = false;
    for (const raw of config.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("[")) {
        inCore = /^\[core(\s|\])/i.test(line);
        continue;
      }
      if (!inCore) continue;
      const m = line.match(/^hooksPath\s*=\s*(.+?)\s*$/i);
      if (m) return expand(m[1]);
    }
    return null;
  }

  function expand(p: string): string {
    if (p === "~") return HOME;
    if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
    return p;
  }

  /**
   * A drifted hooksPath under `.husky` is the benign churn case — husky
   * re-points it on every install and the dispatcher forwards into it, so
   * repair is safe. Anything else is an owner we don't recognise.
   */
  function classifyDrift(hooksPath: string | null): "husky" | "foreign" | null {
    if (hooksPath === null || hooksPath === HOOKS_DIR) return null;
    return /(^|\/)\.husky(\/|$)/.test(hooksPath) ? "husky" : "foreign";
  }

  function hash8(s: string): string {
    return createHash("sha256").update(s).digest("hex").slice(0, 8);
  }

  /** Mirrors _dispatch: prefer <name>-<hash8>, else <name>. */
  function repoKey(name: string, sourceRoot: string | null, known: Set<string>): string {
    if (sourceRoot) {
      const disambiguated = `${name}-${hash8(sourceRoot)}`;
      if (known.has(disambiguated)) return disambiguated;
    }
    return name;
  }

  /** Last "=== ok" / "=== FAILED" marker the dispatcher wrote. */
  function parseLastRun(log: string | null) {
    if (!log) return null;
    const lines = log.split("\n").filter((l) => l.trim().length > 0);
    let at: string | null = null;
    let outcome: "ok" | "failed" | "unknown" = "unknown";
    for (const line of lines) {
      const m = line.match(/^===\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
      if (m) {
        at = m[1];
        outcome = "unknown";
        continue;
      }
      if (/^===\s+ok\s*$/.test(line)) outcome = "ok";
      else if (/^===\s+FAILED/.test(line)) outcome = "failed";
    }
    return at ? { at, outcome } : null;
  }

  async function listSetupKeys(): Promise<Set<string>> {
    try {
      const r = await files().listPaths({
        path: SETUP_DIR,
        includeFiles: true,
        includeDirectories: false,
      });
      const keys = new Set<string>();
      for (const entry of r.paths ?? []) {
        const rel = typeof entry === "string" ? entry : entry.path;
        if (!rel || rel.includes("/")) continue; // logs/ lives one level down
        if (!rel.endsWith(".sh")) continue;
        const key = rel.slice(0, -3);
        if (!RESERVED.has(key)) keys.add(key);
      }
      return keys;
    } catch {
      return new Set();
    }
  }

  async function projectsByRepoName(): Promise<Map<string, { root: string; ids: string[] }>> {
    const out = new Map<string, { root: string; ids: string[] }>();
    let projects: any[] = [];
    try {
      const r: any = await bb.sdk.projects.list();
      // The SDK returns the array itself; older/other shapes wrap it.
      projects = Array.isArray(r) ? r : (r.projects ?? []);
    } catch (error) {
      bb.log.error(`projects.list failed: ${String(error)}`);
      return out;
    }
    for (const p of projects) {
      for (const s of p.sources ?? []) {
        if (s?.type !== "local_path" || !s.path) continue;
        // A project rooted at a directory of repos (e.g. ~/code/Camb-ai) is a
        // container, not a checkout. Only a real repo has .git/config.
        if ((await readText(path.join(s.path, ".git", "config"))) === null) continue;
        const name = path.basename(s.path);
        const existing = out.get(name);
        if (existing) {
          if (!existing.ids.includes(p.id)) existing.ids.push(p.id);
        } else {
          out.set(name, { root: s.path, ids: [p.id] });
        }
      }
    }
    return out;
  }

  async function buildRepo(
    key: string,
    name: string,
    sourceRoot: string | null,
    projectIds: string[],
    scriptKeys: Set<string>,
  ) {
    const scriptPath = path.join(SETUP_DIR, `${key}.sh`);
    const logPath = path.join(LOGS_DIR, `${key}.log`);
    const hooksPath = sourceRoot
      ? parseHooksPath(await readText(path.join(sourceRoot, ".git", "config")))
      : null;
    const log = await readText(logPath);

    return {
      key,
      name,
      sourceRoot,
      scriptPath,
      hasScript: scriptKeys.has(key),
      logPath,
      hooksPath,
      wired: hooksPath === HOOKS_DIR,
      drifted: hooksPath !== null && hooksPath !== HOOKS_DIR,
      driftKind: classifyDrift(hooksPath),
      projectIds,
      lastRun: parseLastRun(log),
    };
  }

  async function globalHooksPath(): Promise<string | null> {
    return parseHooksPath(await readText(path.join(HOME, ".gitconfig")));
  }

  async function collectRepos() {
    const scriptKeys = await listSetupKeys();
    const projects = await projectsByRepoName();
    const repos: any[] = [];
    const claimed = new Set<string>();

    // Repos bb knows about, whether or not they have a script yet.
    for (const [name, { root, ids }] of projects) {
      const key = repoKey(name, root, scriptKeys);
      claimed.add(key);
      repos.push(await buildRepo(key, name, root, ids, scriptKeys));
    }
    // Scripts with no matching project still deserve a row.
    for (const key of scriptKeys) {
      if (claimed.has(key)) continue;
      const name = key.replace(/-[0-9a-f]{8}$/, "");
      repos.push(await buildRepo(key, name, null, [], scriptKeys));
    }

    repos.sort((a, b) => {
      const rank = (r: any) => (r.drifted ? 0 : r.lastRun?.outcome === "failed" ? 1 : 2);
      return rank(a) - rank(b) || a.name.localeCompare(b.name);
    });
    return repos;
  }

  bb.rpc.register(rpcContract, {
    async listRepos() {
      const g = await globalHooksPath();
      return {
        repos: await collectRepos(),
        hooksDir: HOOKS_DIR,
        globalHooksPath: g,
        globalWired: g === HOOKS_DIR,
      };
    },

    async resolveThread({ threadId }) {
      const blank = {
        isWorktree: false as const,
        branchName: null,
        workspacePath: null,
        repo: null,
      };
      let env: any;
      try {
        const thread: any = await bb.sdk.threads.get({ threadId });
        if (!thread?.environmentId) {
          return { ...blank, reason: "This thread has no environment." };
        }
        env = await bb.sdk.environments.get({ environmentId: thread.environmentId });
      } catch (error) {
        return { ...blank, reason: `Could not resolve the thread's environment.` };
      }

      if (!env?.isWorktree) {
        return {
          ...blank,
          reason:
            "This thread runs in the project checkout, not a managed worktree. " +
            "bb only provisions worktrees, so no setup script runs here.",
        };
      }

      const scriptKeys = await listSetupKeys();
      const name = path.basename(env.path);
      // The worktree's source root is the repo identity; fall back to the
      // project's own source when we cannot infer it.
      const projects = await projectsByRepoName();
      const sourceRoot = projects.get(name)?.root ?? null;
      const key = repoKey(name, sourceRoot, scriptKeys);

      return {
        isWorktree: true,
        reason: null,
        branchName: env.branchName ?? null,
        workspacePath: env.path ?? null,
        repo: await buildRepo(key, name, sourceRoot, projects.get(name)?.ids ?? [], scriptKeys),
      };
    },

    async readLog({ key, maxBytes }) {
      const limit = maxBytes ?? 64_000;
      const content = await readText(path.join(LOGS_DIR, `${key}.log`));
      if (content === null) return { content: "", truncated: false, missing: true };
      const truncated = content.length > limit;
      return {
        content: truncated ? content.slice(content.length - limit) : content,
        truncated,
        missing: false,
      };
    },

    async readScript({ key }) {
      const p = path.join(SETUP_DIR, `${key}.sh`);
      try {
        const r = await files().read({ path: p });
        const content =
          r.contentEncoding === "base64"
            ? Buffer.from(r.content, "base64").toString("utf8")
            : r.content;
        return { content, sha256: r.sha256 ?? null, missing: false };
      } catch {
        return { content: "", sha256: null, missing: true };
      }
    },

    async saveScript({ key, content, expectedSha256 }) {
      const result = await files().write({
        path: path.join(SETUP_DIR, `${key}.sh`),
        rootPath: SETUP_DIR,
        content,
        createParents: true,
        mode: 0o755,
        ...(expectedSha256 !== undefined ? { expectedSha256 } : {}),
      });
      if ((result as any).outcome === "conflict") {
        return { outcome: "conflict" as const, sha256: (result as any).currentSha256 ?? null };
      }
      bb.realtime.publish("repos-changed", { key });
      return { outcome: "written" as const, sha256: (result as any).sha256 ?? null };
    },

    /**
     * Rewrite a repo's local core.hooksPath back to the dispatcher. Done by
     * editing .git/config directly: plugins have no shell, and this is the
     * same single-line change `git config core.hooksPath` would make.
     */
    async repairDrift({ key }) {
      const repos = await collectRepos();
      const targets = repos.filter((r) => r.drifted && (key === null || r.key === key));
      const repaired: string[] = [];
      const failed: string[] = [];

      for (const repo of targets) {
        if (!repo.sourceRoot) {
          failed.push(repo.key);
          continue;
        }
        const configPath = path.join(repo.sourceRoot, ".git", "config");
        const current = await readText(configPath);
        if (!current) {
          failed.push(repo.key);
          continue;
        }
        let replaced = false;
        let inCore = false;
        const next = current
          .split("\n")
          .map((raw) => {
            const line = raw.trim();
            if (line.startsWith("[")) {
              inCore = /^\[core(\s|\])/i.test(line);
              return raw;
            }
            if (inCore && /^hooksPath\s*=/i.test(line)) {
              replaced = true;
              return raw.replace(/hooksPath\s*=.*$/i, `hooksPath = ${HOOKS_DIR}`);
            }
            return raw;
          })
          .join("\n");

        if (!replaced) {
          failed.push(repo.key);
          continue;
        }
        try {
          await files().write({ path: configPath, content: next });
          repaired.push(repo.key);
        } catch {
          failed.push(repo.key);
        }
      }

      if (repaired.length > 0) bb.realtime.publish("repos-changed", { repaired });
      return { repaired, failed };
    },

    async bootstrapStatus() {
      return await readBootstrapStatus();
    },

    /**
     * Everything the machine needs, in one call: write the dispatcher and its
     * stubs, point global core.hooksPath at them, and re-point any repo whose
     * local hooksPath was reset by husky.
     */
    async bootstrap({ force }) {
      const steps: { step: string; status: "done" | "skipped" | "failed"; detail: string }[] = [];
      const before = await readBootstrapStatus();

      // 1. hook scripts. rootPath confinement resolves the root symlink-safely,
      // so the directory has to exist before any confined write.
      try {
        await files().mkdir({ path: HOOKS_DIR, recursive: true });
        await files().write({
          path: path.join(HOOKS_DIR, "_dispatch"),
          rootPath: HOOKS_DIR,
          content: DISPATCH,
          createParents: true,
          mode: 0o755,
        });
        for (const name of HOOK_NAMES) {
          await files().write({
            path: path.join(HOOKS_DIR, name),
            rootPath: HOOKS_DIR,
            content: stub(name),
            createParents: true,
            mode: 0o755,
          });
        }
        steps.push({
          step: "Install hook scripts",
          status: "done",
          detail: `${HOOKS_DIR} (_dispatch + ${HOOK_NAMES.length} stubs)`,
        });
      } catch (error) {
        steps.push({ step: "Install hook scripts", status: "failed", detail: String(error) });
        return { ok: false, steps };
      }

      // 2. global core.hooksPath — never silently steal an existing one
      if (before.globalWired) {
        steps.push({ step: "Set global core.hooksPath", status: "skipped", detail: "already wired" });
      } else if (before.globalConflict && !force) {
        steps.push({
          step: "Set global core.hooksPath",
          status: "skipped",
          detail: `already set to ${before.globalHooksPath} — re-run with force to replace it`,
        });
      } else {
        try {
          const configPath = path.join(HOME, ".gitconfig");
          const current = (await readText(configPath)) ?? "";
          await files().write({
            path: configPath,
            content: setHooksPath(current, HOOKS_DIR),
            createParents: true,
          });
          steps.push({ step: "Set global core.hooksPath", status: "done", detail: HOOKS_DIR });
        } catch (error) {
          steps.push({ step: "Set global core.hooksPath", status: "failed", detail: String(error) });
        }
      }

      // 3. repos husky (or anything else) pointed away from us
      if (before.driftedRepos.length === 0) {
        steps.push({ step: "Re-point drifted repos", status: "skipped", detail: "none drifted" });
      } else {
        const repos = await collectRepos();
        const repaired: string[] = [];
        const failed: string[] = [];
        for (const repo of repos.filter((r) => r.drifted)) {
          if (!repo.sourceRoot) {
            failed.push(repo.key);
            continue;
          }
          const configPath = path.join(repo.sourceRoot, ".git", "config");
          const current = await readText(configPath);
          if (!current) {
            failed.push(repo.key);
            continue;
          }
          try {
            await files().write({ path: configPath, content: setHooksPath(current, HOOKS_DIR) });
            repaired.push(repo.key);
          } catch {
            failed.push(repo.key);
          }
        }
        steps.push({
          step: "Re-point drifted repos",
          status: failed.length > 0 ? "failed" : "done",
          detail: failed.length > 0 ? `repaired ${repaired.join(", ")}; failed ${failed.join(", ")}` : repaired.join(", "),
        });
      }

      bb.realtime.publish("repos-changed", { bootstrapped: true });
      return { ok: steps.every((s) => s.status !== "failed"), steps };
    },

    async createScript({ key, repoName }) {
      const p = path.join(SETUP_DIR, `${key}.sh`);
      if ((await readText(p)) !== null) {
        return { created: false, detail: "A script already exists for this repo." };
      }
      await files().mkdir({ path: LOGS_DIR, recursive: true }); // also creates SETUP_DIR
      await files().write({
        path: p,
        rootPath: SETUP_DIR,
        content: starterScript(repoName),
        createParents: true,
        mode: 0o755,
        expectedSha256: null, // create-only
      });
      bb.realtime.publish("repos-changed", { key });
      return { created: true, detail: p };
    },
  });

  /* ── bootstrap ─────────────────────────────────────────────── */

  async function readBootstrapStatus() {
    const dispatch = await readText(path.join(HOOKS_DIR, "_dispatch"));
    const g = await globalHooksPath();
    const repos = await collectRepos();
    const drifted = repos.filter((r) => r.drifted).map((r) => r.key);
    const hooksInstalled = dispatch !== null;
    const hooksStale =
      hooksInstalled && !dispatch!.includes(`worktree-setup v${DISPATCH_VERSION}`);
    return {
      hooksInstalled,
      hooksStale,
      globalHooksPath: g,
      globalWired: g === HOOKS_DIR,
      globalConflict: g !== null && g !== HOOKS_DIR,
      driftedRepos: drifted,
      // `ready` means the machine is wired. Per-repo drift is operational state
      // surfaced in the mounted UI, not a bootstrap blocker — keeping it out of
      // `ready` is what stops drift from ever gating the plugin.
      ready: hooksInstalled && !hooksStale && g === HOOKS_DIR,
    };
  }

  /**
   * Rewrite core.hooksPath in a git config file, adding a [core] section when
   * the file has none. Same edit `git config core.hooksPath` makes — done by
   * hand because plugins have no shell.
   */
  function setHooksPath(config: string, value: string): string {
    const lines = config.split("\n");
    let inCore = false;
    let replaced = false;
    const next = lines.map((raw) => {
      const line = raw.trim();
      if (line.startsWith("[")) {
        inCore = /^\[core(\s|\])/i.test(line);
        return raw;
      }
      if (inCore && /^hooksPath\s*=/i.test(line)) {
        replaced = true;
        return raw.replace(/hooksPath\s*=.*$/i, `hooksPath = ${value}`);
      }
      return raw;
    });
    if (replaced) return next.join("\n");

    // No existing key: append into the first [core] section, else create one.
    const coreIdx = next.findIndex((l) => /^\s*\[core(\s|\])/i.test(l));
    if (coreIdx >= 0) {
      next.splice(coreIdx + 1, 0, `\thooksPath = ${value}`);
      return next.join("\n");
    }
    const body = next.join("\n");
    return `${body}${body.endsWith("\n") ? "" : "\n"}\n[core]\n\thooksPath = ${value}\n`;
  }

  bb.cli.register({
    name: "worktree-setup",
    summary: "Inspect bb worktree setup scripts, logs, and hook wiring",
    commands: [
      { name: "status", summary: "List repos and their hook wiring", usage: "bb worktree-setup status" },
      { name: "log", summary: "Print a repo's setup log", usage: "bb worktree-setup log <repo>" },
      { name: "repair", summary: "Re-point drifted repos at the dispatcher", usage: "bb worktree-setup repair [repo]" },
      { name: "bootstrap", summary: "Report what still needs wiring", usage: "bb worktree-setup bootstrap" },
    ],
    async run(argv) {
      const [cmd, arg] = argv;

      if (cmd === "status" || cmd === undefined) {
        const g = await globalHooksPath();
        const repos = await collectRepos();
        const lines = [
          `global core.hooksPath: ${g ?? "(unset)"}${g === HOOKS_DIR ? " ✓" : " — not wired"}`,
          "",
          ...repos.map((r) => {
            const state = r.drifted ? "DRIFT" : r.hasScript ? "ok" : "no script";
            const last = r.lastRun ? `${r.lastRun.at} ${r.lastRun.outcome}` : "never run";
            return `${r.key.padEnd(28)} ${state.padEnd(10)} ${last}`;
          }),
        ];
        return { exitCode: 0, stdout: lines.join("\n") };
      }

      if (cmd === "log") {
        if (!arg) return { exitCode: 2, stderr: "usage: bb worktree-setup log <repo>" };
        const content = await readText(path.join(LOGS_DIR, `${arg}.log`));
        if (content === null) return { exitCode: 1, stderr: `no log for ${arg}` };
        return { exitCode: 0, stdout: content };
      }

      if (cmd === "repair") {
        const repos = await collectRepos();
        const targets = repos.filter((r) => r.drifted && (!arg || r.key === arg));
        if (targets.length === 0) return { exitCode: 0, stdout: "nothing to repair" };
        const repaired: string[] = [];
        const failed: string[] = [];
        for (const r of targets) {
          const configPath = r.sourceRoot ? path.join(r.sourceRoot, ".git", "config") : null;
          const current = configPath ? await readText(configPath) : null;
          if (!configPath || !current) {
            failed.push(r.key);
            continue;
          }
          try {
            await files().write({ path: configPath, content: setHooksPath(current, HOOKS_DIR) });
            repaired.push(`${r.key} (${r.hooksPath} -> ${HOOKS_DIR})`);
          } catch (error) {
            failed.push(`${r.key}: ${String(error)}`);
          }
        }
          return {
          exitCode: failed.length > 0 ? 1 : 0,
          stdout: repaired.map((r) => `repaired ${r}`).join("\n"),
          ...(failed.length > 0 ? { stderr: failed.map((f) => `failed ${f}`).join("\n") } : {}),
        };
      }

      if (cmd === "bootstrap") {
        const s = await readBootstrapStatus();
        if (s.ready) return { exitCode: 0, stdout: "already set up" };
        return {
          exitCode: 0,
          stdout: [
            "Not fully set up:",
            `  hooks installed: ${s.hooksInstalled ? (s.hooksStale ? "stale" : "yes") : "no"}`,
            `  global core.hooksPath: ${s.globalHooksPath ?? "unset"}`,
            `  drifted repos: ${s.driftedRepos.join(", ") || "none"}`,
            "",
            'Run "Set up git hooks" in Settings → Worktree Setup to fix all of it.',
          ].join("\n"),
        };
      }

      return { exitCode: 2, stderr: `unknown command: ${cmd}` };
    },
  });

  // The plugin stays `running` no matter its bootstrap or drift state. bb-app
  // only mounts a plugin's app bundle while it is running, so reporting
  // `needs-configuration` here would hide the very Settings/thread UI that
  // fixes an unwired machine or a drifted repo. Both are surfaced in-app (the
  // BootstrapCard and the drift banners) and via `bb worktree-setup`.
}
