# 0021: Pull Requests From a Session

- Status: accepted
- Date: 2026-10-22

## Context

A Session's work leaves its provider only when it is pushed ([ADR 0007](0007-session-workspaces.md)). Today the user has to ask Pi to push and then open the pull request on GitHub by hand.

Claude Code's cloud sessions put a **Create PR** button at the top of the diff view. It offers a full pull request, a draft, or GitHub's compose page with a generated title and description, and the session keeps going after the PR is open ([quickstart](https://code.claude.com/docs/en/web-quickstart#review-and-iterate)). Pi Cloud should work the same way.

Two things differ in Pi Cloud:

- There is no GitHub App and no auth in v1 ([ADR 0005](0005-v1-access-and-model-credentials.md)). Git credentials come from the provider's own setup, so only the provider can push.
- The diff view belongs to the `changes` plugin, whose session part already runs in the Session next to the workspace ([ADR 0015](0015-plugins.md)).

## Decision

### A Pi command in the `changes` plugin

- The `changes` session part registers a Pi command, `/pr`, with an optional mode: `draft` or `compose`. No mode means a full pull request.
- Pi runs extension commands at once, even during a turn, and they don't start a turn or enter the transcript. A user can type `/pr` in the composer, and it shows in the `/` menu like any other command.
- The Changes panel puts a **Create PR** button with the three modes on each checkout that has a session branch. A folder Session has no session branch, so it gets no button.
- The web part runs the command through a new `send(text)` on its mounted Session, which posts a `message` command like the composer does. This is the only addition to the plugin seams.

### What `/pr` does, per checkout

1. Writes a title and a description from the commits and the diff against the session branch's base, with the Session's current model. If there is no model or the call fails, the title is the only commit's subject or the branch name, and the description lists the commits.
2. Commits any uncommitted changes, with the title as the message, so the pull request holds what the diff view shows.
3. Pushes the branch to `origin` and sets it as the upstream.
4. For a full or draft pull request, runs `gh pr create` on the provider. If `gh` is missing or not signed in, it falls back to the compose page and says why.
5. For the compose page, builds GitHub's compare URL with the title and description filled in. The browser can't open it on its own, since the result arrives after the click, so the panel shows it as a link.

The pull request targets the repository's default branch. A Session that started from another branch still has to change the base on GitHub. A remote that isn't on GitHub gets the push and no pull request.

### State

- The session part publishes a `pullRequest` value per checkout: working, open (with its URL), pushed, or failed (with the error). The panel shows the button, progress, a **View PR** link or the error from it.
- The URL is kept in the checkout's git config as `branch.<branch>.piCloudPullRequest`, next to `piCloudBase`. The session part publishes it again when the Session starts, so the link survives restarts.
- `/pr` on a branch that already has a pull request commits and pushes, and keeps the same link, like pushing to an open PR on GitHub.

## Consequences

- No credentials reach the server. A provider without push access fails at step 3 with git's own error.
- Auto-fix, CI status and review comments on the PR, which Claude Code also has, need GitHub events on the server. They are left for later.
- `gh` becomes an optional tool on providers. The compose page always works.
- The `changes` plugin now writes to the workspace. It only does so when the user asks.
