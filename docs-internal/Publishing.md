# Publishing mcu-debug

How releases actually get out the door. Most of this is not recoverable from the code, and a
couple of the rules exist because of things that went wrong on other extensions.

Driver script: `scripts/prepare-release.js`. Packaging: `scripts/package-extensions.sh`.

---

## Commands

```bash
# Rehearse. Prints every mutating command, runs none of them.
npm run publish:dryrun -- release-notes.md

# Package + tag + GitHub release, no marketplace publish.
npm run release -- release-notes.md

# The real thing: marketplace publish, then tag, then GitHub release.
npm run publish -- release-notes.md

# ...and Open VSX too (silently skipped for pre-releases; see below).
npm run publish -- release-notes.md --vsx-also
```

A release notes file is required — it becomes the body of the GitHub release.

**Publishing to a marketplace cannot be undone.** Dry-run first. A dry run tolerates a dirty
tree, an unpushed branch and an existing tag, reporting each as a warning, so you can rehearse
mid-work; a real run treats all three as hard errors.

## Tokens

| Variable       | Used for                    |
| -------------- | --------------------------- |
| `VSCE_MD`      | VS Code Marketplace PAT      |
| `OPEN_VSX_PAT` | Open VSX PAT (`--vsx-also`) |

Both are passed to the child process through the environment, never on the command line, so
they cannot appear in `--dryrun` output or in another user's `ps`.

## Version convention: odd minor = pre-release

`0.1.x`, `0.3.x` are pre-releases. `0.2.x`, `0.4.x` are stable. This is forced on us: the
Marketplace does not support semver pre-release tags, only `major.minor.patch`, and a
pre-release and a stable release cannot share a version number.

Both `package-extensions.sh` and `prepare-release.js` derive this from
`packages/mcu-debug/package.json` independently, so `npm run package` on its own still produces
correctly-marked VSIX files.

The `--pre-release` flag is baked in at **package** time, not publish time. Packaging without it
and then publishing produces a *stable* release no matter what the version number says.

Open VSX has no pre-release channel, so `--vsx-also` is ignored for pre-releases rather than
publishing a pre-release as though it were stable.

**GitHub releases are deliberately not marked as pre-releases**, even when the Marketplace
publish is. GitHub defines `/releases/latest` as the newest *non*-prerelease release and offers
no "latest pre-release" equivalent, so marking ours would pin Latest to the last unmarked release
(`v0.1.11`) until an even-minor stable ships — a stale answer that looks like a correct one.
Every release the script creates is the current build. For the occasional build that should not
be treated that way, tick the pre-release box by hand on the GitHub release page.

Revisit this once there is a stable release to anchor Latest, or once we know how people
actually consume these.

## Order: proxy first, then main

`prepare-release.js` publishes `mcu-debug-proxy` before `mcu-debug`. Two reasons:

1. **Dependency resolution.** The main extension lists the proxy in `extensionDependencies`.
   A dependency that does not yet exist in the Marketplace makes the main extension
   uninstallable.
2. **Blast radius.** A *first* publish of a new extension ID is where Marketplace verification
   is most likely to flag something. Publishing the proxy first makes it the canary — if
   verification objects, it objects to the proxy while the main listing is untouched.

Marketplace publish also happens **before** git tagging, so a failed publish does not leave a
tag and GitHub release pointing at a version that never shipped.

We publish the exact VSIX files that `npm run package` produced and that get attached to the
GitHub release, via `vsce publish --packagePath`. Letting `vsce` rebuild during publish would
ship bits that nobody tested and that differ from the GitHub assets.

## Bootstrapping a brand-new extension ID (one time only)

Do **not** publish a new extension that is named as a dependency of another extension in the
same release. It cannot resolve, and it puts dependency resolution and identity verification in
the same submission.

Instead:

1. Publish both extensions **without the new dependency** — that is, leave the new extension out
   of the other's `extensionDependencies`. Existing, already-published dependencies stay; only
   the not-yet-published one is omitted.
2. Wait for both to be accepted and resolvable in the Marketplace.
3. *Then* add the dependency and cut a normal release of the main extension.

This is once per new extension ID, not once per release.

> As of this writing, `packages/mcu-debug` declares four dependencies —
> `debug-tracker-vscode`, `memory-view`, `rtos-views`, `peripheral-viewer` — all already
> published. `mcu-debug-proxy` is the one that has not shipped yet, so it is the only one to
> omit during bootstrap. Do not strip the other four.

## Marketplace verification

First publishes get flagged for impersonation. This has happened to us: an extension was
banned, the publishing **user account** was banned along with it, there was no conversational
support channel, and it took over a month to resolve via Microsoft sales/IT. Assume there is no
human in the loop and no fast appeal.

What reduces the risk:

- Publish under the established `mcu-debug` publisher, which has history. A brand-new publisher
  shipping something resembling an existing name is the pattern that trips the heuristic.
- Keep `displayName`, `description`, `icon`, `categories` and `repository` filled in on every
  extension. A sparse listing looks like a low-effort upload to a classifier.
- A **verified publisher** badge (DNS TXT record on a domain you control) is the strongest
  signal available. A `github.io` subdomain does not qualify.

Note there is a fork of this project on the Marketplace (`mcu-ai-debug`). Its listing resembles
ours by construction, which means a naive similarity check could read the original as the
impersonator. Our defenses are publisher history and chronology.

## `extensionKind` and where things install

`packages/mcu-debug` is `["workspace"]`; `packages/mcu-debug-proxy` is `["ui"]`. In a
WSL/Docker/SSH setup VS Code copies only the workspace-kind extension into the remote, leaving
the proxy on the host — which is correct, because **the host is where the probe is**, and the
proxy has to run next to the probe. Do not "fix" this to match intuition; see the terminology
inversion section in [AGENTS.md](../AGENTS.md).

## Preconditions enforced by the script

- Run from the repo root.
- Release notes file exists and is non-empty.
- `npm run build` succeeds. Build runs **before** the clean-tree check on purpose: `build` runs
  `version:sync`, so building first catches uncommitted version churn.
- Working tree clean, local branch in sync with origin.
- `mcu-debug` and `mcu-debug-proxy` versions match.
- Tag `v<version>` does not already exist locally or on origin.
- Both expected VSIX files exist in `dist/` after packaging.
