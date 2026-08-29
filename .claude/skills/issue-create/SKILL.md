---
name: issue-create
description: Create a tracked Inspector issue end to end — version label, type label, milestone, board card, Status and Priority. Use when filing a new issue, or when work discovered mid-task needs an issue of its own.
disable-model-invocation: true
---

# Creating an issue

An issue **you** create is not "created" until all five of these are true. A
label is a repo tag, the milestone is a release bucket, and the board is a
separate org project — `--label v2` does **not** add a board card, and adding a
card does **not** set a Status or a Priority.

1. **Version label** — exactly one of `v1` / `v2`
2. **Type label** — exactly one of `bug` / `enhancement` / `documentation` / `chore` / `question`
3. **Milestone**
4. **A card on the board for that version** — `v2` → #28, `v1` → #11
5. **Status _and_ Priority set on that card** (Priority is v2-only)

Set the labels and milestone at **create time**, never by backfilling: an
unlabeled issue belongs to no version line and appears in no version-filtered
query, and an unmilestoned one drops out of release planning silently.

**Never create a duplicate.** Check the board for a matching item first.
**Never create a draft card** (a board card with no issue number) — every board
item is a real GitHub issue.

## 0. Check the board first

```sh
gh issue list --repo modelcontextprotocol/inspector --state open --limit 1000 \
  --search "<keywords>" --json number,title,labels,milestone
```

## 1. Pick the labels

**Version.** `v2` is the default for anything new. `v1` is reserved for the
narrow case of patching the deprecated line (security fixes only). If the target
version isn't obvious, it's `v2` — only ask when the issue is specifically a fix
*for released v1 behavior* and it's unclear whether v2 still has the bug.

**Type.** Independent of the version label; every issue needs both.

| Type | Use for | Not for |
| --- | --- | --- |
| `bug` | Something is broken, wrong, or regressed against its intended behavior | A missing capability that was never built |
| `enhancement` | A new capability, or extending an existing one — features, spec support, tracking issues | A cleanup with no behavior change |
| `documentation` | Prose deliverables — READMEs, guides, `specification/` docs, `AGENTS.md` rules | Code that happens to need a doc update |
| `chore` | Maintenance with no user-facing behavior change — deps, build/CI tooling, refactors | Anything a user would notice |
| `question` | An open question or discussion with no agreed deliverable yet | Work someone has already decided to do |

**Don't force the binary.** `bug` and `enhancement` are the two most reached
for, and pressing a docs task or a dependency pin into `enhancement` degrades it
to "not a bug", at which point filtering by it stops telling you anything.

## 2. Pick the milestone

If the user didn't specify one, default to the **current** milestone: the open
one with the nearest due date.

```sh
gh api repos/modelcontextprotocol/inspector/milestones --jq \
  'map(select(.state=="open")) | sort_by(.due_on) | .[] | "\(.title)\tdue \(.due_on[0:10])\topen=\(.open_issues)"'
```

Milestones are **release** buckets (`v2.1.0`, `v2.2.0`, …), so pick by *when the
work ships*, not by size. If a new issue plainly can't make the current
milestone, say so and put it in the next one rather than leaving it blank.
Sub-issues normally inherit their parent's milestone.

⚠️ **Every milestone is a v2 release bucket.** There is no v1 bucket, so a `v1`
issue cannot satisfy the milestone rule — don't drop it in a v2.x one. Leave it
unmilestoned and say so.

## 3. Create it

```sh
gh issue create --repo modelcontextprotocol/inspector \
  --title "<title>" \
  --label v2 --label bug \
  --milestone "v2.5.0" \
  --body "<body>"
```

## 4. Board it, in Todo

Filing an issue for work you intend to happen **is** approving it, so it starts
in **Todo** with its milestone already set — not in Incoming, which is the queue
for issues nobody has evaluated yet. Work you are starting immediately goes
straight to **In Progress**.

```sh
ITEM_ID=$(gh project item-add 28 --owner modelcontextprotocol --url <issue-url> --format json --jq '.id')
# Status → Todo
gh project item-edit --project-id PVT_kwDOCt2Azc4BJVxt --id "$ITEM_ID" \
  --field-id PVTSSF_lADOCt2Azc4BJVxtzg5iI8c --single-select-option-id fbdaf21e
# Priority → Medium (score it with the rubric in /issue-triage; don't eyeball it)
gh project item-edit --project-id PVT_kwDOCt2Azc4BJVxt --id "$ITEM_ID" \
  --field-id PVTSSF_lADOCt2Azc4BJVxtzg5iJE4 --single-select-option-id da944a9c
```

Full ID tables, the v1 board's recipe, and the option-deletion hazard are in
`/board-ops`. The priority rubric is in `/issue-triage`.

## Note on issues that arrive from elsewhere

An issue opened by hand in the GitHub UI — by an outside reporter *or* by a
maintainer — arrives with no label, no milestone, and no card. That is normal on
arrival, not a defect to fix the moment it lands: it comes into the system
through `/issue-triage` instead, and starts in **Incoming** with no milestone,
because nobody has approved it.
