---
name: security-advisory
description: "Take a privately reported vulnerability through this repo's security advisory flow — board it, verify who owns the code path, accept or reject, fix it in the private fork, publish, then file the public issue. Use when a vulnerability is reported privately; when deciding whether an advisory is ours to fix; when looking up or creating its private fork; when answering a reporter; or when a GHSA-titled board card needs handling."
disable-model-invocation: false
---

# Handling a security advisory

Private vulnerability reporting is enabled on this repo and
[`SECURITY.md`](../../../SECURITY.md) routes every report to it — the issue
chooser deliberately has no security template, because a vulnerability report
must not open a public issue. So an advisory never arrives as an issue, and for
most of its life it must **not** become one.

Two steps in this flow are **outward-facing and irreversible-ish, and both stay
human-gated**: **accepting** an advisory (the reporter sees it) and
**publishing** it (it becomes public, assigns a CVE, and credits the reporter —
there is no unpublish). Never automate either, never bulk-apply them, and never
take either step because a checklist said to. Everything else here is mechanics.

Related: `/board-ops` (the card IDs and recipes), `/issue-create` and
`/pr-flow` for the public issue and the eventual release.

## The flow

| # | Step | Gate |
| --- | --- | --- |
| 1 | Advisory lands in state `triage` → **draft card** on board #28 | Mechanical |
| 2 | **Verify the claim — including who owns the code path** | Judgment |
| 3 | Valid → **accept** (`triage` → `draft`); invalid → close with a reason | **Human only** |
| 4 | Create the **private fork**, fix and review there | Mechanical |
| 5 | Merge, release, then **publish** the advisory | **Human only** |
| 6 | After the release, file the public (closed) issue and convert the card | Mechanical |

### 1. Board it as a draft card

An advisory is private, so a public issue tracking it would disclose it before a
fix exists. It therefore gets a **draft card** — the one documented exception to
[`AGENTS.md`](../../../AGENTS.md#issue-driven-work-style)'s "every board item is
a real GitHub issue".

- **Title:** `[GHSA-xxxx-yyyy-zzzz] - <advisory summary>`. That `[GHSA-` prefix
  is not cosmetic: the board audit in `/issue-triage` keys its draft carve-out
  on it, so a card titled any other way is reported as a stray draft.
- **Body:** `**Advisory:** <html_url>` on the first line, then severity and
  reported date, then the advisory description. The link first, because a
  maintainer reading the card has no other route back to the private advisory.
- **Status `Incoming`**, plus a Priority scored with the `/issue-triage` rubric.
  `Incoming` is correct even though somebody clearly triaged it to make the
  card: nobody has approved shipping a fix yet, and a draft card has no
  milestone to carry the approval.

The card is made **by hand**. There is no `PROJECT_TOKEN` in this org and
`organization projects: write` is a permission `GITHUB_TOKEN` structurally
cannot hold, so a board write is unreachable from Actions — the same constraint
`AGENTS.md` records for the dependency sweeps. **Do not propose a nightly
workflow for this;** that approach was tried and abandoned for exactly this
reason.

```sh
gh api repos/modelcontextprotocol/inspector/security-advisories \
  --jq '.[] | select(.state=="triage")
        | "\(.ghsa_id)\t\(.severity)\t\(.summary)"'
```

### 2. Verify the claim — and who owns the code path

Before assessing severity, establish that the vulnerable code is **ours**. A
report can be entirely accurate about behavior the Inspector merely exhibits
because an SDK does it.

⚠️ **This is not hypothetical.** #2409 — a loopback/HTTPS-exemption finding —
read as an Inspector defect and turned out to live in
`@modelcontextprotocol/client` (`typescript-sdk#2591`). The reporter withdrew
it. Had ownership been checked after the severity assessment rather than before,
the fix would have been written against the wrong repo.

So: reproduce it, find the code, and check whether that code is first-party or
reached through a dependency. An advisory against upstream code is closed here
with a pointer to the upstream issue — it is not ours to accept or publish.

### 3. Accept, or close

**Valid and ours → accept.** In the UI this is "Accept and open as draft"; it
moves the advisory `triage` → `draft`. The state is readable as `state` and
`submission.accepted` on the API object.

**Invalid, out of scope, or upstream → close** with a comment saying which, and
why. A reporter who is told nothing reasonably assumes they were ignored.

⚠️ **Accepting is a human act, always.** It is visible to the reporter and it
commits this project to treating the report as a real vulnerability. Nothing in
this skill authorizes taking it — surface the recommendation and let a
maintainer click.

⚠️ **There is no comment API for security advisories.** Not in REST (the
advisory object exposes no comments endpoint) and not in GraphQL
(`RepositoryAdvisory` is not commentable, and no advisory-comment mutation
exists). Comments are **UI-only**, so every exchange with a reporter is manual —
you cannot script the reply, and you cannot read the thread back with `gh`.

### 4. The private fork

Accepted advisories are fixed in a **private fork** GitHub creates for the
advisory: a private repo named `<repo>-<ghsa-id>` in the org.

⚠️ **Read `private_fork` FIRST. The POST is not a probe — it CREATES one.**
Calling it to "check whether a fork exists" makes one, in the org, which then
needs cleaning up. This was learned the hard way.

```sh
# Idempotency check — does one already exist?
gh api repos/modelcontextprotocol/inspector/security-advisories/<GHSA_ID> \
  --jq '.private_fork // "none"'

# Only if that printed "none":
gh api -X POST \
  repos/modelcontextprotocol/inspector/security-advisories/<GHSA_ID>/forks
# → 202 Accepted; the fork appears shortly afterwards.
```

⚠️ **Deleting a private fork needs the `delete_repo` OAuth scope, which a
default `gh` token does not carry.** So a fork created by mistake is not
something you can quietly undo — it takes a re-scoped token or an admin in the
UI. That asymmetry is the whole reason for the read-first rule above.

Fix and review inside the fork. Its PRs and commits are private, so none of the
normal public review flow applies; the diff comes back to `v2/main` as an
ordinary commit at merge time.

### 5. Merge, release, publish

Publish **after** the fix has shipped in a release, never before — publishing
discloses the vulnerability, so doing it while users have no upgrade available
hands out a working exploit.

⚠️ **Publishing is irreversible and human-gated.** It makes the advisory public,
requests a **CVE**, and credits the reporter. There is no undo. Same rule as
accepting: recommend, never perform.

### 6. File the public issue afterwards

Once the advisory is published, the work becomes ordinary board history: file a
public issue recording what shipped, **close it** (the work is already done),
and convert the draft card to that issue so the board stops carrying a draft.
Label and milestone it per `/issue-create`; `Done` is correct here, because the
fix genuinely shipped.

## API facts worth not re-deriving

All verified against the live API.

| Thing | Fact |
| --- | --- |
| States | `triage` → `draft` (accepted) → `published`; or `closed` |
| Accepted? | `submission.accepted` on the advisory object, alongside `state` |
| Private fork | `POST …/security-advisories/{ghsa_id}/forks` → `202`, private repo `<repo>-<ghsa-id>` in the org |
| Fork idempotency | Read `.private_fork` first — the POST creates, it does not probe |
| Fork deletion | Needs the `delete_repo` OAuth scope; a default `gh` token lacks it |
| Comments | **No API at all**, REST or GraphQL. UI-only |
| Board writes | Not automatable — no `PROJECT_TOKEN`, and `GITHUB_TOKEN` cannot hold `organization projects: write` |
