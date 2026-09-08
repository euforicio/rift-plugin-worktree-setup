# bb-plugin-worktree-setup

Per-repo provisioning scripts for fresh [bb](https://github.com/ymichael/bb)
worktrees, with logs, status, and one-click git-hook wiring.

When bb creates a managed worktree it runs `git worktree add`, which checks out
only **tracked** files. Your `.env.local` is gone and `node_modules` is empty.
bb's built-in answer is a committed `.bb-env-setup.sh` at the repo root. This
plugin is the answer for when you don't want that file in git at all.

## How it works

bb creates worktrees with plain git, so git's own `post-checkout` hook fires
during provisioning. This plugin installs a dispatcher at `~/.githooks` and
points `core.hooksPath` at it:

```
bb host daemon → git worktree add → ~/.githooks/post-checkout → _dispatch
                                                                  ├→ ~/.bb-setup/<repo>.sh
                                                                  └→ .husky/_ or .git/hooks
```

Nothing lives in your repositories. Setup scripts sit in `~/.bb-setup/`, logs in
`~/.bb-setup/logs/`.

A non-zero exit from your setup script becomes the exit status of
`git worktree add`, so bb fails provisioning rather than opening a broken
worktree.

## Install

```sh
bb plugin install git:https://github.com/KaviiSuri/bb-plugin-worktree-setup.git@main
```

Then open **Settings → Worktree Setup** and click **Set up git hooks**. That
writes the dispatcher, sets global `core.hooksPath`, and re-points any repo
whose local config points elsewhere. Nothing touches your git config until you
click.

## Surfaces

- **Thread panel.** Open *Worktree Setup* beside *Terminal* in any thread's
  right panel: repo, branch, hook status, log, and an editable setup script.
  Threads without a worktree get an explanation rather than an error.
- **Settings section.** Every repo, its wiring state, drift warnings, and
  script/log editing.
- **CLI.** `bb worktree-setup status | log <repo> | repair [repo] | bootstrap`

## Repos, not projects

The unit is a **repo**, not a bb project. bb strips every `BB_*` variable from
the hook environment, so at execution time the only available key is the
worktree's directory name. Keying the UI by repo keeps the UI key and the
runtime key identical, so no mapping can drift out of sync.

Two repos can share a basename, so identity is really the source root. The
dispatcher prefers `<name>-<hash8>.sh` (hash of the source root) and falls back
to the readable `<name>.sh`.

## The husky problem

husky sets `core.hooksPath = .husky/_` **locally**, and local git config beats
global. Two consequences:

1. The dispatcher delegates to `.husky/_/<hook>` (and `.git/hooks/<hook>`), so
   installing it never costs you an existing hook.
2. In husky repos the plugin sets the local `core.hooksPath` to `~/.githooks`.
   husky's `prepare` script resets that on **every `npm install`**, silently
   stopping worktree setup while husky keeps working.

The plugin detects this as *drift* and offers one-click repair. It's the main
reason the plugin exists rather than just a shell script.

## Limits

- One machine only. Repo discovery uses the bb server's own home directory.
  `bb.sdk.files` takes a `hostId`, so multi-machine is a small change.
- Only one hook system is called per hook name. husky wins over `.git/hooks`
  if a repo somehow has both.
- POSIX only; the dispatcher is bash.

## Development

```sh
npm install            # installs the pinned bb-app used for builds
npm run typecheck
npm run build          # npx bb plugin build
npx bb plugin install .
npx bb plugin dev      # watch + reload
```

`hooks.ts` is the source of truth for everything written to `~/.githooks`.
Edit it there and re-run bootstrap; never hand-edit the installed copies.

## Releasing

Releases are git tags (`vX.Y.Z`) that users pin against:

```sh
bb plugin install git:https://github.com/KaviiSuri/bb-plugin-worktree-setup.git@v0.2.0
```

Either flow bumps the version in `package.json`, rebuilds `dist/`, commits both,
and creates an annotated `vX.Y.Z` tag so the tagged commit always carries a
fresh build.

**Locally.** Nothing is pushed unless you pass `--push`:

```sh
scripts/release.sh patch          # 0.1.0 -> 0.1.1, commit + tag only
scripts/release.sh minor --push   # bump, build, tag, and push to origin
scripts/release.sh 1.4.2 --push   # explicit version
```

**On demand via GitHub.** Run the **Release** workflow from the Actions tab
(or `gh workflow run release.yml -f bump=patch`). Pick `patch`/`minor`/`major`,
or `custom` with an exact version; it bumps, builds, tags, and pushes for you.

## License

MIT

## Fork provenance

Rift Labs fork: https://github.com/euforicio/rift-plugin-worktree-setup
Upstream: https://github.com/KaviiSuri/bb-plugin-worktree-setup
