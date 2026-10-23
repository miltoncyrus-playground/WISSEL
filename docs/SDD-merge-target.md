# SDD — A card lands on its own branch, and auto-merge has an off switch

Status: **Built.** `TaskCard.mergeTarget`, `validateMergeTarget`,
`createTaskWorktree`'s `baseRef`, the target-aware landing in
`mergeTaskWorktree`, `carriedCardSettings`, review cards inheriting their
parent's harness and target, and `WISSEL_AUTO_MERGE`. `test/merge-target.test.ts`
lands real commits in throwaway git repos.

## 1. The problem

A card's worktree was cut from the repo's current `HEAD`, and Merge
fast-forwarded the repo's current `HEAD`. Whatever branch happened to be
checked out decided where every card started and where it landed. With
several cards for different tickets in one repo, three cards landed on
the wrong branch and each needed a hand repair (cherry-pick onto a clean
branch, reset the wrong one). A second cause: the reviewer agent
declares `autoMerge: true`, so an approved review landed the card with no
human click, before anyone had checked out the right branch.

## 2. Design

### 2.1 `mergeTarget` on the card

`TaskCard.mergeTarget` is a plain local branch name, set when the card is
created (`POST /tasks`, a schedule template's creation goes through the
same `validateNewTask`). It is stored in a new `tasks.mergeTarget` column
(additive `ALTER TABLE`, like every column before it). Undefined means
"today's behaviour": the worktree comes off `HEAD` and the merge
fast-forwards `HEAD`.

`validateMergeTarget` refuses what git or a shell could misread: a
leading dash, `..`, `//`, `@{`, whitespace, a trailing `/`, `.` or
`.lock`, `HEAD`, a full `refs/...` name, over 100 characters. A bad value
is a 400 at creation, never a surprise at merge time.

### 2.2 The worktree branches from the target

`createTaskWorktree(repo, key, { baseRef })` makes sure the local branch
exists (`ensureTargetBranch`): if it does not, it is created from the
repo's default branch (`origin/HEAD`, `origin/main`, `origin/master`,
`main`, `master`, and last `HEAD`), then the worktree is added from
`refs/heads/<target>`. WriteExecutor and CodexWriteExecutor pass
`task.mergeTarget`. With no target the `git worktree add` command is
unchanged.

### 2.3 The merge lands on the target

`mergeLocked` reads `base` from `refs/heads/<target>` instead of `HEAD`.
The landing commit is built the same way, against that base.

- **Target is the checked-out branch:** the existing path. The overlap
  check and `git merge --ff-only` run as before, so the working tree is
  updated.
- **Target is another branch:** `git update-ref refs/heads/<target>
  <landing> <base>`. The old value makes it a compare-and-swap, so a
  branch that moved since `base` fails and retries once, then reports
  `head-moved`. The checked-out branch, its working tree and index are
  never touched, so there is nothing to overlap.
- **Target branch missing at merge time:** an `error` outcome that names
  the branch. It never falls back to `HEAD`.

The result message names the branch (`landed wissel/<id> on branch
<target> of <repo> at <sha>`).

### 2.4 Settings that follow the card

`carriedCardSettings` (a pushback re-attempt and a human retry) now
carries `mergeTarget`. A review card created by `spawnReviewerTask`
inherits its parent's `harnessOverride` and `mergeTarget`: before this,
a review card was created unpinned and could run on any enabled account.

### 2.5 `WISSEL_AUTO_MERGE`

`autoMergeAllowed(agent)` is true only when the agent declares
`autoMerge: true` with `trustLevel: "high"` and the switch is on. The
switch is on unless `WISSEL_AUTO_MERGE` is `0`, `off`, `false` or `no`.
With it off, an approved card stops in `review` for a human Merge. Unset
keeps today's behaviour. It is read at all three decision points in the
orchestrator.

## 3. What is deliberately not here

- Crash recovery and merge health still reason about the repo's `HEAD`.
  A card with a target that is not checked out is recorded by its landed
  sha like any other, but "already landed" detection by `HEAD` ancestry
  does not see it. Left for a follow-up.
- No project-level default target and no branch-name template. Each
  card names its branch.
- No push. Landing is local; pushing and opening the pull request is a
  separate human-gated step (a later item).

## 4. Tests

`test/merge-target.test.ts`: the validator; no target keeps the exact old
`git worktree add ... HEAD`; a target made from `main` while another
branch is checked out, landing on the target and leaving the checkout
untouched; a checked-out target taking the fast-forward; no target
landing on `main` as before; a target that moved after the worktree was
cut; a missing target as a clear error; `carriedCardSettings`; the
auto-merge switch.
