# Always-on work: goals, triggers and usage

Dots can work without you in the chat. Scheduled tasks, standing goals and triggers each start a turn in a conversation on the server, even with the browser closed. Every one of those turns follows the usual rules: one turn per Dot at a time, approvals for risky actions, owner handoff for passwords and codes, and the limits in `.env`.

Open **Scheduled and activity** (the clock in the sidebar footer) to see everything that runs in the background: triggers, token use per Dot, and the task list.

## Scheduled tasks and goals

Use the clock button in a conversation. You can choose one of three kinds of work:

| Kind   | What it does                                                                                                            |
| ------ | ----------------------------------------------------------------------------------------------------------------------- |
| Once   | Runs one time.                                                                                                          |
| Repeat | Runs again after each successful run, at the interval you pick.                                                         |
| Goal   | Runs on a schedule until the Dot decides the goal is achieved, then stops. Each run is a turn in the same conversation. |

A goal's run starts with "Standing goal, run N" and the objective. The Dot reads what earlier runs did in the conversation, takes the next step, and calls `mark_goal_done` with a short summary once the goal is achieved. Only the goal's own scheduled turn can close it; a chat message cannot. The summary appears in the task list, and the goal is marked **Achieved**.

Repeats and goals take an optional run limit ("Stop after"). When it is reached, nothing more is scheduled.

A run that is cut off by a restart, a settings change or an expired lease is marked **Interrupted** and waits for you to retry it, because some of its actions may already have happened.

## Parallel background work

Several Dots can work in the background at the same time. `BACKGROUND_CONCURRENCY` sets how many (default 2, at most 8). A Dot never runs two turns at once, so two tasks of the same Dot still wait for each other. Tasks of a conversation that waits for your approval or handoff are skipped until you decide.

## Triggers

Use the lightning button in a conversation to add a trigger. When a trigger fires, FullDots adds an event task to that conversation. The task starts with your instructions, followed by the event data inside a fence and marked as untrusted. The runner then runs it like any other task.

### Webhook triggers

Another service calls a URL, for example GitHub when an issue opens, Stripe when a payment fails, or your own script. FullDots shows the URL and a new secret once, right after you create the trigger. If you lose the secret, rotate it from the activity view; the old one stops working at once.

| Proof             | How the caller sends it                                                                                          | Use it for                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Bearer token      | `Authorization: Bearer <secret>`                                                                                 | Your scripts, Zapier, Make and most services with custom headers                       |
| Signed body       | A header with an HMAC-SHA256 of the raw body: `X-Hub-Signature-256: sha256=<hex>` by default, as GitHub sends it | GitHub and services that sign their deliveries                                         |
| Secret in the URL | `?token=<secret>` in the URL                                                                                     | Services that can only call a plain URL. Anyone who sees the URL can fire the trigger. |

Rules for every webhook:

- **Bodies:** up to 256 KB, as JSON, form data or plain text.
- **Rate limit:** at most 30 calls a minute per trigger.
- **Redeliveries:** a call that repeats a delivery id (`X-GitHub-Delivery`, `X-Delivery-Id`, `Idempotency-Key` or `X-Request-Id`) runs once. Without an id, the same body within ten minutes counts as a retry.
- **Unknown triggers:** a disabled, deleted or unknown trigger answers 404.
- **Secrets:** bearer and URL secrets are stored only as SHA-256 hashes. A signing secret is sealed with the connector key (AES-256-GCM), because checking a signature needs it in plain text. The API never returns a secret after creation.

The webhook URL uses `APP_ORIGIN`. For a service on the internet to reach it, FullDots must be reachable from the internet, for example through a tunnel or on a server. The webhook route follows the same host rule as the rest of the API: without an `OWNER_TOKEN`, only `localhost`, `127.0.0.1` and the `APP_ORIGIN` host are accepted. It does not need the owner token itself, because each trigger has its own secret.

### Poll triggers

FullDots calls a read-only connector tool on a schedule, from every minute to once a day, and fires when the answer changes. Examples are a list of new issues or the newest messages. The first call only records a baseline. To compare one part of the answer instead of all of it, give a field path such as `issues.0.id`. Only tools that are marked read-only and that the Dot is granted can be polled. If the grant is removed, polling stops and the trigger shows why.

## Token use and budgets

FullDots records the tokens each Dot uses per UTC day, from the usage the model provider reports at the end of every turn. Turns from a provider that reports no usage are counted as turns but not as tokens, and the activity view says so.

- **Warning:** once a Dot passes `DOT_DAILY_TOKEN_WARN` tokens in a day (default 2,000,000), you are warned once that day through `NOTIFY_WEBHOOK_URL`.
- **Daily budget (optional):** set it per Dot in the activity view. When a Dot reaches it, its scheduled tasks, goals and trigger events wait until the next UTC day. Chat with that Dot still works, because you started it.

## Settings

| Variable                 | Default   | Purpose                                          |
| ------------------------ | --------- | ------------------------------------------------ |
| `BACKGROUND_CONCURRENCY` | 2         | Background tasks running at once (1 to 8).       |
| `DOT_DAILY_TOKEN_WARN`   | 2,000,000 | Tokens per Dot per day before the warning.       |
| `NOTIFY_WEBHOOK_URL`     | none      | Where warnings, approvals and handoffs are sent. |
| `APP_ORIGIN`             | none      | The address used in webhook URLs.                |
