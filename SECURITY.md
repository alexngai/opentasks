# Security Policy

## Supported versions

OpenTasks is pre-1.0. Security fixes are applied to the latest published `0.x`
release on npm.

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report privately via GitHub's
[private vulnerability reporting](https://github.com/alexngai/opentasks/security/advisories/new)
("Report a vulnerability" under the repository's **Security** tab).

Please include:

- A description of the issue and its impact
- Steps to reproduce (a minimal proof of concept if possible)
- Affected version(s)

You can expect an initial acknowledgement within a few days. Once a fix is
released, we're happy to credit reporters who wish to be named.

## Scope notes

OpenTasks runs a **local** Unix-socket daemon and stores its graph in
`.opentasks/` inside your repository. It does not open network ports. When git
sync is enabled, it commits and pushes `graph.jsonl` to whatever remote you
configure — treat that data with the same sensitivity as the rest of your repo.
