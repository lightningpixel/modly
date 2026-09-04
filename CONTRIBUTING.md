# Contributing to Modly

Thanks for wanting to help out! You don't need write access to the repository to
pick up a ticket, work on it, and ship a fix — here's how the flow works.

## Finding something to work on

- Browse [open issues](https://github.com/lightningpixel/modly/issues) or the
  [project board](https://github.com/users/lightningpixel/projects/1).
- Issues labeled `good first issue` are a good place to start if you're new to
  the codebase. See [`CLAUDE.md`](./CLAUDE.md) for an architecture overview.

## Claiming a ticket

Comment **`/assign`** on the issue you want to work on. A bot will assign it to
you automatically — no repo permissions required.

- Only one person can be assigned to an issue at a time. If it's already
  assigned, ask the assignee first or wait for them to release it.
- No longer working on it? Comment **`/unassign`** to free it up for someone
  else.

This keeps the [project board](https://github.com/users/lightningpixel/projects/1)
honest: an assigned issue moves to **In progress** automatically, so anyone
looking at the board can see what's actively being worked on.

## Submitting your work

1. **Fork** the repository and create a branch for your change.
2. Make your change. Keep it focused — one issue, one PR.
3. Run the checks locally before opening a PR:
   ```bash
   npm run lint
   npm run test
   ```
4. Open a **pull request** against `dev`. Include `Closes #<issue-number>` in
   the PR description so it's linked to the ticket and closes it automatically
   on merge.

Opening a PR from your fork moves the linked issue to **Ready to review** on
the board. Once a maintainer approves the review, it moves to **Ready to
test**; once merged, it moves to **Done**.

## Getting help

If something in an issue is unclear, ask in a comment on the issue itself
before starting — it's cheaper to clarify scope up front than to redo work
later.
