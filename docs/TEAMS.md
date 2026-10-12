# Teams of Dots

A Dot can hand part of a task to a teammate whose role fits it better. For example, a lead Dot hands research to Scout, Scout hands the writing to Writer, and the result comes back to the conversation where you asked.

## Set up a team

Open a Dot's settings (its menu in the sidebar, **Edit Dot**) and tick the Dots it may hand work to under **Team**. A Dot with no team never sees the hand-off tools.

## How a hand-off works

1. **The Dot hands work over.** It calls `delegate_to_dot` with the teammate's name, a self-contained brief and the deliverable it needs. The teammate does not see the original conversation, so the brief must carry the context.
2. **The teammate starts.** FullDots creates a new conversation for the teammate, titled "From _Dot_: _brief_", and runs the work there as a background task. You can open that conversation in the sidebar and watch it.
3. **The teammate works with its own settings.** It uses its own model, connectors, computer permissions, approval mode and token budget. Nothing is inherited from the Dot that asked.
4. **The result comes back.** When the teammate finishes, its final answer is posted to the original conversation as a new turn labelled **Delegated work**. The Dot that asked continues from there. If the teammate fails, that Dot is told why and decides what to do next.

A Dot can also call `check_delegation` to see whether handed work is still running.

## Limits

- **Depth:** hand-offs chain at most `TEAM_MAX_DEPTH` levels (default 2). A Dot that is already two levels down does its part itself.
- **No loops:** a Dot cannot hand work back to a Dot above it in the same chain.
- **Per turn:** a turn can hand over at most three pieces of work.
- **Usual rules:** hand-off tasks wait like any other background work, for paused Dots, busy Dots, pending approvals and spent budgets.
- **Deleted conversation:** if you delete the conversation that asked, its running hand-offs are cancelled.

## Settings

| Variable         | Default | Purpose                                |
| ---------------- | ------- | -------------------------------------- |
| `TEAM_MAX_DEPTH` | 2       | How many hand-offs may chain (1 to 5). |
