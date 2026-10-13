# Teams of Dots

A Dot can hand part of a task to a teammate whose role fits it better. For example, a lead Dot hands research to Scout, Scout hands the writing to Writer, and the result comes back to the conversation where you asked.

## Set up a team

Open a Dot's settings (its menu in the sidebar, **Edit Dot**) and tick the Dots it may hand work to under **Team**. A Dot with no team never sees the hand-off tools.

## How a hand-off works

1. **The Dot hands work over.** It calls `delegate_to_dot` with the teammate's name, a self-contained brief and the deliverable it needs. The teammate does not see the original conversation, so the brief must carry the context.
2. **The teammate starts.** FullDots creates a new conversation for the teammate, titled "_Lead_ → _Teammate_: _first line of the brief_", and runs the work there as a background task, usually within a fraction of a second. You can open that conversation in the sidebar and watch it.
3. **The teammate works with its own settings.** It uses its own model, connectors, computer permissions, approval mode and token budget. Nothing is inherited from the Dot that asked.
4. **The teammate replies with the deliverable.** Its brief asks for the deliverable only: no preamble, no plan, no "I am ready".
5. **The result comes back.** When the teammate finishes, its final answer is posted to the original conversation as a new turn labelled **Delegated work**. The Dot that asked continues from there. If the teammate fails, that Dot is told why and decides what to do next.

A Dot can also call `check_delegation` to see whether handed work is still running.

## Several hand-offs at once

When a Dot hands work to several teammates in one turn, they work in parallel (up to `BACKGROUND_CONCURRENCY` at once, one turn per Dot) and their results come back together in **one** turn, with a section per teammate, including the ones that failed. The results wait for each other for at most `TEAM_RESULT_BATCH_MS` (1.5 seconds) after the first one arrived; what has arrived by then goes back together, and a result that arrives later gets a turn of its own. Waiting results are stored, so a restart neither loses nor repeats them.

The lead's reply starts as soon as its conversation is free: the end of any turn in that conversation, or of any turn of that Dot, retries the waiting results at once instead of on the 30 second safety sweep.

Each hand-off records when the teammate started (`startedAt`) and when its result reached the Dot that asked (`deliveredAt`); both are in `GET /api/conversations/:id/delegations`.

## Time limit

A teammate's turn on handed-over work may take `DELEGATION_TIMEOUT` seconds (default 300) instead of the usual `AGENT_TURN_TIMEOUT` (90 seconds plus grace). Shortly before the limit it is asked to wrap up; at the limit it stops and the Dot that asked receives what it has, with a note that it ran out of time. Other turns keep their usual limits.

## Speed check

`npm run bench:team` (or `node --import tsx scripts/team-bench.ts [iterations]`) runs hand-offs on a temporary database with an instant fake model and prints p50 and p95 for: hand-off to teammate start, last result to the lead's reply, the start spread of three teammates, and live event delivery. It needs no model key and is not part of the test suite.

## Limits

- **Depth:** hand-offs chain at most `TEAM_MAX_DEPTH` levels (default 2). A Dot that is already two levels down does its part itself.
- **No loops:** a Dot cannot hand work back to a Dot above it in the same chain.
- **Per turn:** a turn can hand over at most three pieces of work.
- **Usual rules:** hand-off tasks wait like any other background work, for paused Dots, busy Dots, pending approvals and spent budgets.
- **Deleted conversation:** if you delete the conversation that asked, its running hand-offs are cancelled.

## Settings

| Variable                 | Default | Purpose                                                                  |
| ------------------------ | ------- | ------------------------------------------------------------------------ |
| `TEAM_MAX_DEPTH`         | 2       | How many hand-offs may chain (1 to 5).                                   |
| `DELEGATION_TIMEOUT`     | 300     | Seconds a teammate's turn on handed-over work may take (0 = no limit).   |
| `TEAM_RESULT_BATCH_MS`   | 1500    | Milliseconds one turn's results wait for each other (0 to 60000).        |
| `BACKGROUND_CONCURRENCY` | 4       | Background tasks, hand-offs included, running at once on different Dots. |
