// The first thing a new chat shows: one line that invites a message, above the message box.
// Everything else (the Dot's profile, the computer panel) stays out of the way until the person
// opens it.

const INVITATIONS = [
  'What should we get done today?',
  'What is on your mind?',
  'Where should we start?',
  'What can I take off your plate?',
  'What are you working on?',
] as const;

export function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** One invitation a day: it changes tomorrow, not every time the window is opened. */
export function invitation(now: Date): string {
  const day = Math.floor(
    (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) -
      Date.UTC(now.getFullYear(), 0, 1)) /
      86_400_000,
  );
  return INVITATIONS[day % INVITATIONS.length];
}

export function ChatWelcome({
  dotName,
  configured,
  onSettings,
  now = new Date(),
}: {
  dotName: string;
  /** Whether a model is connected; without one nothing can be sent yet. */
  configured: boolean;
  onSettings: () => void;
  now?: Date;
}) {
  if (!configured)
    return (
      <div className="start-hero">
        <p className="start-hero-eyebrow">Welcome to FullDots</p>
        <h1>Connect a model and {dotName} is ready.</h1>
        <p className="start-hero-note">
          Add a provider key, or a local model, and start your first
          conversation.
        </p>
        <button type="button" className="primary" onClick={onSettings}>
          Open Settings
        </button>
      </div>
    );
  return (
    <div className="start-hero">
      <p className="start-hero-eyebrow">
        {greeting(now)}. {dotName} is here.
      </p>
      <h1>{invitation(now)}</h1>
    </div>
  );
}
