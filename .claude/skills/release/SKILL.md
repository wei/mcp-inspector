---
name: release
description: Cut an Inspector v2 release — bump the version on v2/main first, merge the milestone into main, tag origin/main with a bare x.y.z, and publish via the GitHub Release. Also covers the v1 line and what the publish jobs gate on.
disable-model-invocation: true
---

# Cutting a release

Background on what ships and why (the `files` allowlist, the bundling rules, the
container image) is in [`docs/publishing.md`](../../../docs/publishing.md). This
skill is the procedure.

A v2 release is cut from **`main`**, after the milestone's work has been merged
there from `v2/main` — not from `v2/main` itself. The v1 line releases
independently from `v1/main` to the `v1-latest` tag and never touches `main`.

Publishing is automated by two release-gated jobs in
`.github/workflows/main.yml` (`github.event_name == 'release'`), both
`needs: [build, coverage]` — so a release cannot publish with either the build
job or the coverage gate red:

- **`publish`** — runs `npm run pack:verify` as the pre-publish gate, asserts the
  release tag matches the root `package.json` version, then `npm publish
  --access public --provenance`.
- **`publish-github-container-registry`** — the GHCR image.

There is **one version number** (only the root `package.json` has one — the
clients carry none), so the flow is three steps.

## 1. Bump on `v2/main`, before the milestone merge

The bump is part of the milestone's work, so it belongs on the develop branch
and flows into `main` with everything else.

```sh
git checkout -b v2/chore/<ISSUE>-bump-2-3-0 v2/main
npm version minor --no-git-tag-version   # or major / patch; bump only, no tag
# PR → v2/main
```

⚠️ **`--no-git-tag-version` is load-bearing.** A bare `npm version` also tags,
and the tag would land on a `v2/main` commit — but the release must be cut from
`main`, so the tag has to point at the merge commit there (step 3). Tagging here
creates a tag on a commit that is never released.

## 2. Merge `v2/main` → `main`

Through the usual milestone-merge branch. It now carries the bump, so the
release lands on `main` with the version already correct.

Between steps 1 and 2 the two branches **do** differ, and that is expected, not
drift: `v2/main` reads the version being built while `main` still reads the one
currently released. What this ordering removes is *post-release* drift — once the
milestone merge lands they agree again, and `v2/main` is never left **behind**
`main`. If you see `v2/main` ahead of `main`, a release is in flight; if you see
it behind, something went wrong.

## 3. Tag `origin/main` and draft the Release

```sh
git fetch origin main
git tag 2.3.0 origin/main && git push origin 2.3.0
# then draft & publish a GitHub Release for that tag → triggers `publish`
```

⚠️ **Tag `origin/main`, not your local `HEAD`.** `git checkout main && git pull`
resolves through whatever merge-or-rebase strategy you have configured, so a
divergent local `main` can quietly produce or replay local commits. Tagging
`HEAD` there tags a commit that is not on `origin/main`, and `git push origin
<tag>` pushes only the tag — leaving a release whose commit was never published.

⚠️ **No `v` prefix.** This repo's release tags are bare `x.y.z` — `2.2.0`,
`2.1.0`, `2.0.0`. npm's own `tag-version-prefix` defaults to `v` and the repo
sets no `.npmrc`, so a bare `npm version` would have produced a mismatched tag;
tagging by hand is what keeps it right. (The workflow's assert step strips a
leading `v` before comparing, so a `v`-prefixed tag would still publish — it
would just be inconsistent with every previous release.)

The release's target commit selects which workflow runs, so this only publishes
when a release is cut from a commit carrying the v2 workflow.

## Why the bump goes on `v2/main` first (#2010)

It used to happen on the milestone-merge branch, which is cut from `main` — so
the bump existed only *downstream* of `v2/main` and nothing carried it back.
`v2/main` sat at `2.0.0` through both the 2.1.0 and 2.2.0 releases. That is not
cosmetic: a branch cut from a milestone-merge branch silently carries the bump
into an unrelated PR (this happened on #2009, where a container bugfix arrived
with a `2.0.0 → 2.2.0` diff), and anything reading the version in development
reported a version two releases old.

⚠️ **Never close a drift by merging `main` into `v2/main`.** `main` carries the
entire pre-v2 v1 history (~230 commits `v2/main` does not have), so a back-merge
grafts all of it into the develop branch's log permanently in order to deliver a
two-file change. Bumping first means there is nothing to back-merge.

## The v1 line

Flat: `feature branch → v1/main → npm v1-latest`, with no merge into `main` at
any point. The two lines publish independently under separate dist-tags, so a v1
fix does **not** need forward-porting to reach users on
`npx @modelcontextprotocol/inspector@v1-latest`.
