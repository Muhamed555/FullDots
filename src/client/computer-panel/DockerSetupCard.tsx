import { useCallback, useEffect, useRef, useState } from 'react';
import { Container, LoaderCircle } from 'lucide-react';
import { api } from '../api';
import type {
  DockerPlan,
  DockerSetupStatus,
  DockerStep,
} from '../../shared/docker-setup-types';

const POLL_MS = 1500;

/** Which steps to offer next, given what is known about Docker. */
export function nextSteps(status: DockerSetupStatus): DockerStep[] {
  switch (status.docker) {
    case 'not_installed':
      return ['install-docker', 'check'];
    case 'stopped':
      return ['start-docker', 'check'];
    case 'ready':
      return ['create-computers', 'check'];
    default:
      return ['check'];
  }
}

/**
 * Sets up Dot computers without a terminal. Every step shows the exact commands first and runs them
 * only after the owner allows them; the server checks that the commands it runs are the ones shown.
 * It renders nothing when the setup is unavailable (FullDots in a container, or a network address).
 */
export function DockerSetupCard({ onDone }: { onDone: () => void }) {
  const [status, setStatus] = useState<DockerSetupStatus>();
  const [asking, setAsking] = useState<DockerStep>();
  const [error, setError] = useState('');
  const finished = useRef('');

  const load = useCallback(async () => {
    try {
      setStatus(await api<DockerSetupStatus>('/docker/setup'));
    } catch {
      setStatus(undefined);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const running = status?.job?.state === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  const job = status?.job;
  useEffect(() => {
    if (
      job?.state === 'done' &&
      job.step === 'create-computers' &&
      finished.current !== job.id
    ) {
      finished.current = job.id;
      onDone();
    }
  }, [job, onDone]);

  if (!status?.enabled) return null;
  const plan = (step: DockerStep): DockerPlan =>
    status.plans.find((item) => item.step === step)!;
  const asked = asking && plan(asking);

  const allow = async () => {
    if (!asked) return;
    setError('');
    try {
      await api(`/docker/setup/${asked.step}`, 'POST', {
        approve: asked.commands,
      });
      setAsking(undefined);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start.');
    }
  };

  return (
    <section className="cp-docker" aria-label="Docker setup">
      <h4>
        <Container size={14} aria-hidden="true" /> Set up with Docker
      </h4>
      <p>
        {status.docker === 'unknown'
          ? 'Check whether Docker is ready. Nothing is installed or started until you allow each step.'
          : status.docker === 'ready'
            ? 'Docker is running.'
            : status.docker === 'stopped'
              ? 'Docker is installed but not running.'
              : 'Docker is not installed.'}
      </p>
      {asked ? (
        <div className="cp-docker-ask" role="group" aria-label="Allow commands">
          <strong>FullDots will run:</strong>
          {asked.commands.length > 0 && (
            <pre>
              <code>{asked.commands.join('\n')}</code>
            </pre>
          )}
          <p>{asked.note}</p>
          <div className="cp-empty-actions">
            {asked.supported && (
              <button
                type="button"
                className="cp-btn cp-btn-primary"
                onClick={() => void allow()}
              >
                Allow and run
              </button>
            )}
            <button
              type="button"
              className="cp-btn"
              onClick={() => setAsking(undefined)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="cp-empty-actions">
          {nextSteps(status).map((step, index) => (
            <button
              key={step}
              type="button"
              className={`cp-btn${index === 0 ? ' cp-btn-primary' : ''}`}
              disabled={running}
              onClick={() => {
                setError('');
                setAsking(step);
              }}
            >
              {step === 'check' && status.docker !== 'unknown'
                ? 'Check again'
                : plan(step).title}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="cp-docker-error" role="alert">
          {error}
        </p>
      )}
      {job && (
        <div className="cp-docker-job" aria-live="polite">
          <p>
            {running && (
              <LoaderCircle className="cp-spin" size={13} aria-hidden="true" />
            )}{' '}
            {job.message}
          </p>
          {job.state === 'failed' && job.output && (
            <details>
              <summary>Technical details</summary>
              <pre>
                <code>{job.output}</code>
              </pre>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
