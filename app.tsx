import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  useRealtime,
  useRpc,
} from "@riftlabs/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { rpcContract } from "./server";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

type Repo = {
  key: string;
  name: string;
  sourceRoot: string | null;
  scriptPath: string;
  hasScript: boolean;
  logPath: string;
  hooksPath: string | null;
  wired: boolean;
  drifted: boolean;
  driftKind: "husky" | "foreign" | null;
  projectIds: string[];
  lastRun: { at: string; outcome: "ok" | "failed" | "unknown" } | null;
};

/* ── shared bits ──────────────────────────────────────────── */

function Dot({ repo }: { repo: Repo }) {
  const cls = repo.drifted
    ? "bg-attention"
    : repo.lastRun?.outcome === "failed"
      ? "bg-destructive"
      : repo.hasScript
        ? "bg-success"
        : "bg-muted";
  return <span className={`size-1.5 shrink-0 rounded-full ${cls}`} />;
}

function Pill({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "ok" | "warn" | "bad";
  children: React.ReactNode;
}) {
  const tones = {
    neutral: "border-border text-muted-foreground",
    ok: "border-success text-success",
    warn: "border-warning-text text-warning-text",
    bad: "border-destructive text-destructive",
  } as const;
  return (
    <span className={`rounded-full border px-2 py-px font-mono text-2xs ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** Colourises the dispatcher's own log markers. Everything else stays plain. */
function LogView({ content }: { content: string }) {
  if (!content.trim()) {
    return (
      <div className="rounded-md border border-dashed border-border bg-sidebar p-6 text-center font-mono text-2xs text-muted-foreground">
        No runs recorded yet.
      </div>
    );
  }
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-sidebar p-3 font-mono text-2xs leading-relaxed">
      {content.split("\n").map((line, i) => {
        let cls = "";
        if (/^===\s+ok\s*$/.test(line)) cls = "text-success";
        else if (/^===\s+FAILED/.test(line)) cls = "text-destructive";
        else if (/^===/.test(line)) cls = "text-timeline-accent";
        else if (/WARNING|warn:/i.test(line)) cls = "text-warning-text";
        return (
          <div key={i} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

function ScriptEditor({ rpc, repoKey }: { rpc: Rpc; repoKey: string }) {
  const [text, setText] = useState<string | null>(null);
  const [sha, setSha] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void rpc.call("readScript", { key: repoKey }).then((r) => {
      if (cancelled) return;
      setText(r.missing ? "#!/usr/bin/env bash\nset -uo pipefail\n\n" : r.content);
      setSha(r.sha256);
    });
    return () => {
      cancelled = true;
    };
  }, [rpc, repoKey]);

  const save = useCallback(async () => {
    if (text === null) return;
    setSaving(true);
    try {
      const r = await rpc.call("saveScript", { key: repoKey, content: text, expectedSha256: sha });
      if (r.outcome === "conflict") {
        toast.error("Script changed on disk since it was opened — reopen to merge.");
        setSha(r.sha256);
        return;
      }
      setSha(r.sha256);
      toast.success("Setup script saved");
    } finally {
      setSaving(false);
    }
  }, [rpc, repoKey, text, sha]);

  if (text === null) {
    return <div className="p-4 text-2xs text-muted-foreground">Loading…</div>;
  }
  return (
    <div className="space-y-2">
      <textarea
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        className="h-56 w-full resize-y rounded-md border border-border bg-sidebar p-3 font-mono text-2xs leading-relaxed outline-none focus:border-input"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <span className="ml-auto font-mono text-2xs text-muted-foreground">
          ~/.bb-setup/{repoKey}.sh
        </span>
      </div>
    </div>
  );
}

function DriftBanner({
  repo,
  onRepair,
  didNotRun,
}: {
  repo: Repo;
  onRepair: () => void | Promise<void>;
  /** In a worktree thread, drift means setup already silently no-op'd here. */
  didNotRun?: boolean;
}) {
  const husky = repo.driftKind === "husky";
  return (
    <div className="mb-3 flex items-center gap-3 rounded-md border border-attention bg-surface-attention p-2.5 text-2xs">
      <span>
        <b className="text-warning-text">
          {didNotRun ? "Setup did not run for this worktree." : "hooksPath drift."}
        </b>{" "}
        This repo points at <code className="font-mono">{repo.hooksPath}</code>, so bb bypasses the
        dispatcher and {didNotRun ? "skipped" : "will skip"} setup on new worktrees.{" "}
        {husky ? (
          <>husky re-points this on every install — repair again after installs.</>
        ) : (
          <>Another tool owns <code className="font-mono">core.hooksPath</code>; repair only if you
          did not set this deliberately.</>
        )}
      </span>
      <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={() => void onRepair()}>
        Repair
      </Button>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md border border-border bg-sidebar px-2.5 py-2">
      <div className="text-2xs text-muted-foreground">{label}</div>
      <div className={`font-mono text-2xs ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

/* ── thread panel ─────────────────────────────────────────── */

function ThreadPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<
    Awaited<ReturnType<Rpc["call"]>> | null
  >(null);
  const [tab, setTab] = useState<"log" | "script">("log");
  const [log, setLog] = useState("");

  const load = useCallback(async () => {
    const r = (await rpc.call("resolveThread", { threadId })) as any;
    setState(r);
    if (r.repo) {
      const l = await rpc.call("readLog", { key: r.repo.key });
      setLog(l.content);
    }
  }, [rpc, threadId]);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime("repos-changed", () => void load());

  if (!state) return <div className="p-4 text-2xs text-muted-foreground">Loading…</div>;

  const s = state as any;

  if (!s.isWorktree) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
        <div className="mb-1.5 text-xs text-muted-foreground">No worktree for this thread</div>
        <div className="max-w-sm text-2xs leading-relaxed text-muted-foreground">{s.reason}</div>
      </div>
    );
  }

  const repo: Repo = s.repo;
  return (
    <div className="space-y-3">
      <div className="font-mono text-2xs text-muted-foreground">
        repo <b className="font-medium text-foreground">{repo.name}</b>
        {s.branchName ? (
          <>
            {" · branch "}
            <b className="font-medium text-foreground">{s.branchName}</b>
          </>
        ) : null}
      </div>

      {repo.drifted ? (
        <DriftBanner
          repo={repo}
          didNotRun
          onRepair={async () => {
            const r = await rpc.call("repairDrift", { key: repo.key });
            if (r.repaired.length) toast.success("hooksPath repaired");
            else toast.error("Could not repair — edit .git/config by hand");
            await load();
          }}
        />
      ) : null}

      <div className="grid grid-cols-3 gap-2">
        <Stat
          label="hooksPath"
          value={repo.wired ? "~/.githooks" : (repo.hooksPath ?? "unset")}
          tone={repo.wired ? "text-success" : "text-warning-text"}
        />
        <Stat label="Setup script" value={repo.hasScript ? "present" : "missing"} />
        <Stat
          label="Last run"
          value={repo.lastRun ? `${repo.lastRun.outcome} · ${repo.lastRun.at.slice(5)}` : "never"}
          tone={
            repo.lastRun?.outcome === "failed"
              ? "text-destructive"
              : repo.lastRun?.outcome === "ok"
                ? "text-success"
                : undefined
          }
        />
      </div>

      <div className="flex gap-1 border-b border-border">
        {(["log", "script"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-2.5 py-1.5 text-2xs ${
              tab === t
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground"
            }`}
          >
            {t === "log" ? "Log" : "Setup script"}
          </button>
        ))}
      </div>

      {tab === "log" ? <LogView content={log} /> : <ScriptEditor rpc={rpc} repoKey={repo.key} />}
    </div>
  );
}

/* ── settings section ─────────────────────────────────────── */

function RepoRow({ repo, rpc, reload }: { repo: Repo; rpc: Rpc; reload: () => void }) {
  const [open, setOpen] = useState(repo.drifted);
  const [log, setLog] = useState<string | null>(null);
  const [view, setView] = useState<"none" | "log" | "script">("none");

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-state-hover"
      >
        <Dot repo={repo} />
        <span className="min-w-[150px] font-mono text-2xs">{repo.name}</span>
        <span className="flex-1 truncate text-2xs text-muted-foreground">
          {repo.projectIds.length
            ? `${repo.projectIds.length} project${repo.projectIds.length > 1 ? "s" : ""}`
            : "no bb project"}
          {repo.lastRun ? ` · last run ${repo.lastRun.outcome}` : " · never run"}
        </span>
        {repo.drifted ? <Pill tone="warn">drift</Pill> : null}
        {!repo.hasScript ? <Pill>no script</Pill> : null}
        {repo.lastRun?.outcome === "failed" ? <Pill tone="bad">failed</Pill> : null}
        <span className="text-2xs text-muted-foreground">{open ? "▾" : "▸"}</span>
      </button>

      {open ? (
        <div className="bg-sidebar px-3.5 pb-3.5 pl-8">
          {repo.drifted ? (
            <DriftBanner
              repo={repo}
              onRepair={async () => {
                const r = await rpc.call("repairDrift", { key: repo.key });
                if (r.repaired.length) toast.success("hooksPath repaired");
                else toast.error("Could not repair automatically");
                reload();
              }}
            />
          ) : null}

          <dl className="mb-2 space-y-1 text-2xs">
            {[
              ["Source root", repo.sourceRoot ?? "— unknown —"],
              ["Setup script", repo.hasScript ? repo.scriptPath : "— none —"],
              ["Log", repo.logPath],
            ].map(([k, v]) => (
              <div key={k} className="flex gap-2.5 border-b border-border py-1 last:border-b-0">
                <dt className="w-28 shrink-0 text-muted-foreground">{k}</dt>
                <dd className="min-w-0 flex-1 break-all font-mono">{v}</dd>
              </div>
            ))}
          </dl>

          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                if (!repo.hasScript) {
                  const r = await rpc.call("createScript", { key: repo.key, repoName: repo.name });
                  if (r.created) toast.success(`Created ${r.detail}`);
                  reload();
                }
                setView(view === "script" ? "none" : "script");
              }}
            >
              {repo.hasScript ? "Edit script" : "Create script"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                if (view === "log") return setView("none");
                const l = await rpc.call("readLog", { key: repo.key });
                setLog(l.content);
                setView("log");
              }}
            >
              View log
            </Button>
          </div>

          {view === "script" ? (
            <div className="mt-3">
              <ScriptEditor rpc={rpc} repoKey={repo.key} />
            </div>
          ) : null}
          {view === "log" ? (
            <div className="mt-3">
              <LogView content={log ?? ""} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Shown until the machine is wired. One button does the whole job — writing
 * the hooks, setting global core.hooksPath, and re-pointing drifted repos.
 */
function BootstrapCard({ status, rpc, reload }: { status: any; rpc: Rpc; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<any[] | null>(null);

  const run = useCallback(
    async (force: boolean) => {
      setBusy(true);
      try {
        const r = await rpc.call("bootstrap", force ? { force: true } : {});
        setSteps(r.steps);
        if (r.ok) toast.success("Git hooks set up");
        else toast.error("Some steps failed — see details");
        reload();
      } finally {
        setBusy(false);
      }
    },
    [rpc, reload],
  );

  const problems = [
    !status.hooksInstalled && "hook scripts are not installed",
    status.hooksStale && "installed hooks are out of date",
    !status.globalWired &&
      `global core.hooksPath is ${status.globalHooksPath ?? "unset"}`,
  ].filter(Boolean) as string[];

  return (
    <div className="mb-4 rounded-lg border border-attention bg-surface-attention p-3.5">
      <div className="mb-1 text-xs font-semibold text-warning-text">
        Git hooks are not set up
      </div>
      <div className="mb-2.5 text-2xs text-muted-foreground">
        Worktree setup runs from a git <code className="font-mono">post-checkout</code> hook. Until
        it is wired, nothing runs when bb creates a worktree.
      </div>
      <ul className="mb-3 space-y-0.5 text-2xs text-muted-foreground">
        {problems.map((p) => (
          <li key={p}>· {p}</li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void run(false)} disabled={busy}>
          {busy ? "Setting up…" : "Set up git hooks"}
        </Button>
        {status.globalConflict ? (
          <Button size="sm" variant="outline" onClick={() => void run(true)} disabled={busy}>
            Replace existing hooksPath
          </Button>
        ) : null}
      </div>
      {status.globalConflict ? (
        <div className="mt-2 text-2xs text-muted-foreground">
          Your global <code className="font-mono">core.hooksPath</code> already points at{" "}
          <code className="font-mono">{status.globalHooksPath}</code>. It will not be replaced
          unless you choose to.
        </div>
      ) : null}
      {steps ? (
        <dl className="mt-3 space-y-1 border-t border-attention pt-2.5 text-2xs">
          {steps.map((s) => (
            <div key={s.step} className="flex gap-2">
              <dt
                className={
                  s.status === "done"
                    ? "text-success"
                    : s.status === "failed"
                      ? "text-destructive"
                      : "text-muted-foreground"
                }
              >
                {s.status === "done" ? "✓" : s.status === "failed" ? "✕" : "–"}
              </dt>
              <dd className="min-w-0 flex-1">
                {s.step}
                <span className="ml-1.5 break-all font-mono text-muted-foreground">{s.detail}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function SettingsSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<any>(null);
  const [boot, setBoot] = useState<any>(null);

  const load = useCallback(async () => {
    const [repos, status] = await Promise.all([
      rpc.call("listRepos", null),
      rpc.call("bootstrapStatus", null),
    ]);
    setData(repos);
    setBoot(status);
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime("repos-changed", () => void load());

  if (!data) return <div className="p-4 text-2xs text-muted-foreground">Loading…</div>;

  const repos: Repo[] = data.repos;
  const drifted = repos.filter((r) => r.drifted);

  return (
    <div>
      {boot && !boot.ready ? (
        <BootstrapCard status={boot} rpc={rpc} reload={() => void load()} />
      ) : null}

      {drifted.length > 0 ? (
        <div className="mb-4 rounded-lg border border-attention bg-surface-attention p-3.5">
          <div className="mb-1 text-xs font-semibold text-warning-text">
            {drifted.length} repo{drifted.length > 1 ? "s" : ""} drifted
          </div>
          <div className="mb-3 text-2xs text-muted-foreground">
            These repos point <code className="font-mono">core.hooksPath</code> away from the
            dispatcher, so bb <b>silently skips setup</b> on their new worktrees until repaired.
            {drifted.some((r) => r.driftKind === "husky")
              ? " husky re-points on every install, so this can recur."
              : ""}
          </div>
          <ul className="mb-3 space-y-0.5 font-mono text-2xs text-muted-foreground">
            {drifted.map((r) => (
              <li key={r.key}>
                · {r.name}{" "}
                <span className="text-warning-text">
                  ({r.driftKind === "husky" ? "husky-managed" : "foreign owner"})
                </span>
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            onClick={async () => {
              const r = await rpc.call("repairDrift", { key: null });
              if (r.repaired.length) toast.success(`Repaired ${r.repaired.length}`);
              if (r.failed.length) toast.error(`Could not repair ${r.failed.length}`);
              void load();
            }}
          >
            Repair all
          </Button>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-border">
      <div className="border-b border-border px-3.5 pb-2.5 pt-3">
        <div className="text-xs font-semibold">Repositories</div>
        <div className="text-2xs text-muted-foreground">
          One setup script per repo, identified by its source root. Runs on every new bb worktree.
        </div>
      </div>

      {repos.length === 0 ? (
        <div className="p-6 text-center text-2xs text-muted-foreground">No repositories found.</div>
      ) : (
        repos.map((r) => <RepoRow key={r.key} repo={r} rpc={rpc} reload={() => void load()} />)
      )}

      <div className="flex items-center gap-2.5 border-t border-border bg-sidebar px-3.5 py-2.5 text-2xs text-muted-foreground">
        <span>
          Global <code className="font-mono">core.hooksPath</code>
        </span>
        {data.globalWired ? (
          <Pill tone="ok">~/.githooks</Pill>
        ) : (
          <Pill tone="warn">{data.globalHooksPath ?? "unset"}</Pill>
        )}
        <span className="flex-1" />
        {drifted.length > 0 ? (
          <>
            <span>
              {drifted.length} repo{drifted.length > 1 ? "s" : ""} drifted
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                const r = await rpc.call("repairDrift", { key: null });
                toast.success(`Repaired ${r.repaired.length}`);
                void load();
              }}
            >
              Repair all
            </Button>
          </>
        ) : (
          <span>all wired</span>
        )}
      </div>
      </div>
    </div>
  );
}

/* ── registration ─────────────────────────────────────────── */

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "worktree-setup",
    title: "Worktree Setup",
    icon: "Wrench",
    // No `run`: always open the tab and let the component explain a
    // non-worktree thread, rather than refusing with a toast.
    component: ({ threadId }) => <ThreadPanel threadId={threadId} />,
  });

  app.slots.settingsSection({
    id: "repos",
    title: "Worktree setup",
    description: "Per-repo provisioning scripts for fresh bb worktrees.",
    component: SettingsSection,
  });
});
