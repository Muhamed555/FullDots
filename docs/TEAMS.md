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

## Watching teammates work

Where a Dot hands work over, the chat shows a **work band**: one lane per teammate, in the teammate's colour. A small packet in the lead's colour flies to each lane as the work is handed over.

Each lane shows the teammate's character, its name, the first line of the brief (**Whole brief** opens the rest), what it is doing right now ("Opening website", "Using github", "Thinking"), the last two lines it wrote, how long it has worked and how many tokens it used. Every state is written out as well as shown:

| Lane says                                | Meaning                                                                                              |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Queued                                   | The hand-off waits for a free background slot.                                                       |
| Working, or the current step             | The teammate is working on it.                                                                       |
| Waiting: _Scout_ is busy in another chat | The teammate finishes a turn elsewhere first. Nothing there is interrupted.                          |
| Waiting: daily budget reached            | The teammate spent its token budget for today (UTC).                                                 |
| Waiting: _Scout_ is paused               | Resume the Dot to let it start.                                                                      |
| Waiting for your approval                | The approval card is in the lane: approve or deny it there.                                          |
| Your turn on the computer                | **Take over** opens the teammate's chat and its computer.                                            |
| Failed                                   | The error, with **Try again** (the same brief to the same teammate, as a new hand-off) and **Skip**. |
| Stopped by you                           | You stopped it. **Try again** is offered here too.                                                   |

A teammate that stops to wait for you (an approval, a takeover, a question) does not report back yet: its result is the reply it gives after you answered.

**Watching the chat itself.** The chevron on a lane opens the teammate's chat inside the lane and streams it live; **Open chat** goes to it. At most two lanes stream at once (opening a third closes the oldest), so the browser keeps connections free for the rest of the app.

**Stopping.** **Stop** on a lane, or **Stop everything** in the chat header, cancels the hand-off and anything it handed on. A teammate's turn is stopped only when it runs in that hand-off's own chat: a Dot that is busy in another chat keeps going there. The lead hears which work you stopped, together with the results that still come back, and is told not to redo it unless you ask.

**When the results return** the band folds into one chip per teammate (**Show the work** opens it again), the **Delegated work** turn shows a card per teammate with a summary and **Show full result**, and the lead's combined answer below it says which teammates it was **Built from**.

**Sidebar.** A teammate's chat sits under the chat that handed the work over (the arrow folds it), with the teammate's character. A small pulse marks any chat with work running in it or under it, and each Dot row says whether the Dot is **Working** or **Needs you**.

**Keyboard and screen readers.** Each lane is a focusable group named after its teammate and its state. On a focused lane, Enter opens or closes its chat, S stops it, and A moves to its approval buttons. Lane changes are announced politely, at most once every two seconds per lane. With reduced motion the packet, the pulses and the bobbing are off and every change is instant, still in words.

The lanes read `GET /api/conversations/:id/delegations/progress` (owner only) and fetch it again when the live feed reports a change for the chat or its teammates' chats, and every 1.5 seconds while a teammate works. The other lane routes are `POST /api/conversations/:id/delegations/stop`, `POST /api/delegations/:id/stop`, `POST /api/delegations/:id/retry` and `GET /api/delegations/:id` (the whole result).

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
- **Try again:** one hand-off can be tried at most five times in all; after that, ask the lead to hand it over again.

## Group chats

A conversation can have more than one Dot. The Dot you started it with is its **host**; the others are **participants** you added. Every Dot in the chat sees the whole conversation and answers in it with its own character, name and colour.

- **Mention a Dot.** Type `@` in the message box to pick a Dot (arrow keys, Enter or Tab to insert, Escape to close), or type `@Name` yourself. A message without a mention goes to the host, as before.
- **Adding asks once.** Mentioning a Dot that is not in the chat yet asks "Add _Writer_ to this chat? It will see the whole conversation." Nothing is sent until you choose **Add**; **Cancel** keeps your message in the box. You can also add a Dot with **+** in the chat header, and remove a participant with the small cross on its picture there.
- **Several mentions.** `@Scout find the dates, @Writer draft the post` gives each mentioned Dot its own turn in this chat, one after another in the order you mentioned them. The queue lives in your open page: each Dot starts once the previous one finished, and closing the page drops the Dots still waiting. Your message is stored once per Dot and shown once ("Also to Writer").
- **One turn at a time.** A chat runs one turn at a time. While a Dot answers, Send is disabled; if a message still meets a running turn, the chat names the Dot that is answering and offers **Send again** or **Stop the other work and send**.
- **Passing the baton.** A Dot can pass the chat to another Dot in it with `hand_to_dot` (the host counts as a member too). The next Dot takes the following turn in the same chat with the whole history, and the chat shows "_Scout_ handed to _Writer_". A hand-off counts against the three hand-offs per turn shared with `delegate_to_dot`, and it follows the **Hand work to teammates** rule: under Ask me first you approve each pass first.
- **Relay cap.** At most `TEAM_RELAY_MAX` Dot turns (default 4) run in a row without a message from you: the turn your message started plus the passes after it, queued ones included. Beyond that the Dot is told to finish its reply and the chat waits for you.

Safety:

- Only **your** mentions start turns. `@Name` written by a Dot, returned by a tool or found on a web page is plain text and dispatches nothing; the only way for a Dot to involve another is the gated `hand_to_dot` tool, and only to Dots you added.
- The server refuses a turn for a Dot that is neither the host nor a participant on every path: the chat runtime, `POST /api/conversations/:id/turns`, headless turns and resume turns. A pass waiting for a Dot you removed is dropped.
- Each Dot keeps its own settings in the chat: model, approval mode, rules, pause, token budget and its one-turn-at-a-time lock. A message you address to a Dot counts as a chat message (`source: chat`), so approvals behave exactly as when you type to the host. A pass to a Dot over its daily budget waits like other background work.

API: `GET`/`POST /api/conversations/:id/participants` (`{ dotId }`, the confirm), `DELETE /api/conversations/:id/participants/:dotId`, `POST /api/conversations/:id/turns` (`{ text, dotId }`, answers 202 once the turn started; 403 for a Dot not in the chat, 409 while a turn runs), and `POST /api/conversations/:id/stop`. `/api/workspace` lists `participantIds` with each conversation.

## Settings

| Variable                 | Default | Purpose                                                                  |
| ------------------------ | ------- | ------------------------------------------------------------------------ |
| `TEAM_MAX_DEPTH`         | 2       | How many hand-offs may chain (1 to 5).                                   |
| `DELEGATION_TIMEOUT`     | 300     | Seconds a teammate's turn on handed-over work may take (0 = no limit).   |
| `TEAM_RESULT_BATCH_MS`   | 1500    | Milliseconds one turn's results wait for each other (0 to 60000).        |
| `BACKGROUND_CONCURRENCY` | 4       | Background tasks, hand-offs included, running at once on different Dots. |
| `TEAM_RELAY_MAX`         | 4       | Dot turns in a row in a group chat without your message (1 to 20).       |
