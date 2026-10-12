# Roadmap

FullDots aims to give always-on AI coworkers with their own computers, app connectors, approvals and teams, while staying local-first, private, model-agnostic and self-hosted. This is what is done and what is next.

| Phase | What the owner gets                                                                                   | Status  | Settings it adds                                                               |
| ----- | ----------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------ |
| 0     | Working Docker setup, an audit trail, labels on server-started turns, per-Dot pause, `npm run backup` | Done    | none                                                                           |
| 1     | MCP connectors with presets, browser sign-in and per-Dot tool grants                                  | Done    | `CONNECTORS_ALLOW_STDIO`, `CONNECTOR_RESULT_MAX_CHARS`, `CONNECTOR_SECRET_KEY` |
| 2     | Approvals before risky actions, owner handoff for passwords and codes, resume after restart           | Done    | `APPROVAL_TTL`, `NOTIFY_WEBHOOK_URL`                                           |
| 3     | Standing goals, parallel background work, webhook and poll triggers, token use and budgets            | Done    | `BACKGROUND_CONCURRENCY`, `DOT_DAILY_TOKEN_WARN`                               |
| 4     | Reach your Dots from anywhere: Telegram chat and approvals, an installable mobile app                 | Planned | to come                                                                        |
| 5     | Teams of Dots: a Dot hands work to a teammate and gets the result back                                | Done    | `TEAM_MAX_DEPTH`                                                               |

Also planned: a guide for running FullDots on a VPS ([#17](https://github.com/asasemahmed/FullDots/issues/17)).

Guides: [Connectors](CONNECTORS.md) · [Approvals](APPROVALS.md) · [Automations](AUTOMATIONS.md) · [Teams](TEAMS.md) · [Setup](SETUP.md)

Ideas and help are welcome. The [open issues](https://github.com/asasemahmed/FullDots/issues) list what is up for grabs, and the pinned issue explains how to start.
