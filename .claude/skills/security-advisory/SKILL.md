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

Related: `/board-ops` (the card IDs and recipes) and `/issue-create`, for the
public issue **after** publication.

⚠️ **`/pr-flow` does not apply to the fix itself.** It requires a public issue
and a public PR against `v2/main` — the disclosure this flow exists to delay.
The fix is reviewed inside the private fork (step 4), and `/pr-flow` becomes
relevant only once the advisory is published.

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
  ⚠️ **Put the score's arithmetic in the draft body**, under the description.
  `/issue-triage` says to record it as an issue comment, and a draft card has
  no comments — so without this the Priority is a bare word with nothing behind
  it, and a later re-scoring cannot tell a judgment from a guess. Write the two
  axes, the bonuses you claimed, and the total, exactly as the comment form
  would.
  ⚠️ **Set both fields.** The board audit's non-Issue check now exempts
  `[GHSA-` drafts, so a half-made card no longer trips it; the audit carries a
  narrow replacement check (see `/issue-triage`) and it is the only thing
  looking.

The card is made **by hand**. There is no `PROJECT_TOKEN` in this org and
`organization projects: write` is a permission `GITHUB_TOKEN` structurally
cannot hold, so a board write is unreachable from Actions — the same constraint
`AGENTS.md` records for the dependency sweeps. **Do not propose a nightly
workflow for this;** that approach was tried and abandoned for exactly this
reason.

```sh
# --paginate: this endpoint returns 30 per page, and an inventory that silently
# stops at the first page is worse than none — it reads as "nothing pending".
gh api --paginate repos/modelcontextprotocol/inspector/security-advisories \
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
reached through a dependency. An advisory against upstream code is not ours to
accept or publish.

⚠️ **"Upstream's problem" is not a reason to say it in public.** A genuine
unfixed vulnerability handed to a public upstream issue is disclosed — by us,
on someone else's behalf, before they have a fix. Route it through **that
project's own private reporting channel** (its `SECURITY.md`, or its advisory
form), and only reference a public upstream issue once the upstream has
published. Where the reporter would rather carry it over themselves, say so and
let them. #2409 took the benign version of this path: the reporter withdrew the
report here and raised it upstream.

### 3. Accept, or close

**Valid and ours → accept.** In the UI this is "Accept and open as draft"; it
moves the advisory `triage` → `draft`. The state is readable as `state` and
`submission.accepted` on the API object.

**Invalid, out of scope, or upstream → close** with a comment saying which, and
why. A reporter who is told nothing reasonably assumes they were ignored.

⚠️ **Closing an advisory leaves its draft card behind — delete it.** Nothing
shipped, so `Done` would be a false record and `Incoming` would claim work is
still queued; `AGENTS.md` deletes a card in exactly this situation, and a
rejected advisory's card is now invisible to the audit's non-Issue check by
construction. The delete recipe is in `/board-ops`.

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

### 6. Convert the card afterwards

Once the advisory is published, the work becomes ordinary board history and the
draft card becomes a real issue.

⚠️ **Convert FIRST — the order is not interchangeable.** GitHub's "Convert to
issue" creates a **new** issue from the draft; there is no way to point an
existing card at an issue you filed separately. Filing the issue by hand and
then converting produces two issues and two cards, which is why this step reads
the way it does:

1. **Convert the draft card to an issue** on board #28 (the card keeps its
   place and its field values; the issue is created from the card's title and
   body).
2. Apply `v2` and a type label, and a milestone — the one the fix shipped in.
   Do **not** run `/issue-create`'s add-card step: the card already exists.
3. **Close it.** The work shipped before the issue existed.
4. Move the card to **`Done`** — correct here, because the fix genuinely
   shipped.

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
