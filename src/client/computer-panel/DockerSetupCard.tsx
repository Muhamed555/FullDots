import { useCallback, useEffect, useRef, useState } from 'react';
import { Container, LoaderCircle } from 'lucide-react';
import { api } from '../api';
import type {
  DockerJob,
  DockerPlan,
  DockerSetupStatus,
  DockerState,
  DockerStep,
} from '../../shared/docker-setup-types';

const POLL_MS = 1500;
/** Steps that usually take minutes, so the card says so instead of looking stuck. */
const SLOW_STEPS: readonly DockerStep[] = [
  'install-docker',
  'create-computers',
];

const DOCKER_TEXT: Record<DockerState, string> = {
  unknown:
    'FullDots can set up computers for you. Nothing runs until you allow each step.',
  not_installed: 'Docker is not installed.',
  stopped: 'Docker is installed but not running.',
  ready: 'Docker is running.',
};

/** Which steps to offer next, the recommended one first, given what is known about Docker. */
export function nextSteps(docker: DockerState): DockerStep[] {
  switch (docker) {
    case 'not_installed':
      return ['install-docker', 'check'];
    case 'stopped':
      return ['start-docker', 'check'];
    case 'ready':
      return ['create-computers', 'check'];
    case 'unknown':
      return ['check'];
  }
}

export function stepLabel(
  step: DockerStep,
  plan: DockerPlan,
  docker: DockerState,
) {
  return step === 'check' && docker !== 'unknown' ? 'Check again' : plan.title;
}

/**
 * Sets up Dot computers without a terminal. Each step first shows the exact commands it will run on
 * this machine and runs them only once the owner allows it; the server refuses commands that differ.
 * Command output stays hidden unless a step fails. Renders nothing where the setup is unavailable.
 */
export function DockerSetupCard({ onDone }: { onDone: () => void }) {
  const [status, setStatus] = useState<DockerSetupStatus>();
  const [asking, setAsking] = useState<DockerStep>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const reported = useRef('');

  // A failed poll keeps what is shown: the server may just be restarting.
  const load = useCallback(async () => {
    try {
      setStatus(await api<DockerSetupStatus>('/docker/setup'));
    } catch {
      // Shown again on the next successful poll.
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const job = status?.job;
  const running = job?.state === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  useEffect(() => {
    if (
      job?.state === 'done' &&
      job.step === 'create-computers' &&
      reported.current !== job.id
    ) {
      reported.current = job.id;
      onDone();
    }
  }, [job, onDone]);

  if (!status?.enabled) return null;
  const plans = new Map(status.plans.map((plan) => [plan.step, plan]));
  const asked = asking ? plans.get(asking) : undefined;

  const allow = async (plan: DockerPlan) => {
    setSending(true);
    setError('');
    try {
      await api(`/docker/setup/${plan.step}`, 'POST', {
        approve: plan.commands,
      });
      setAsking(undefined);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start.');
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="cp-docker" aria-labelledby="cp-docker-title">
      <h4 id="cp-docker-title">
        <Container size={14} aria-hidden="true" /> Set up with Docker
      </h4>
      <p>{DOCKER_TEXT[status.docker]}</p>
      {asked ? (
        <Confirm
          plan={asked}
          sending={sending}
          onAllow={() => void allow(asked)}
          onCancel={() => setAsking(undefined)}
        />
      ) : (
        <div className="cp-empty-actions">
          {nextSteps(status.docker).map((step, index) => {
            const plan = plans.get(step);
            if (!plan) return null;
            return (
              <button
                key={step}
                type="button"
                className={index === 0 ? 'cp-btn cp-btn-primary' : 'cp-link'}
                disabled={running}
                onClick={() => {
                  setError('');
                  setAsking(step);
                }}
              >
                {stepLabel(step, plan, status.docker)}
              </button>
            );
          })}
        </div>
      )}
      {error && (
        <p className="cp-docker-error" role="alert">
          {error}
        </p>
      )}
      {job && <JobResult job={job} />}
    </section>
  );
}

function Confirm({
  plan,
  sending,
  onAllow,
  onCancel,
}: {
  plan: DockerPlan;
  sending: boolean;
  onAllow: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="cp-docker-ask" role="group" aria-label={plan.title}>
      <p>{plan.note}</p>
      {plan.supported && (
        <>
          <strong>FullDots will run these commands on this computer:</strong>
          <pre>
            <code>{plan.commands.join('\n')}</code>
          </pre>
        </>
      )}
      <div className="cp-docker-buttons">
        {plan.supported && (
          <button
            type="button"
            className="cp-btn cp-btn-primary"
            onClick={onAllow}
            disabled={sending}
          >
            {sending ? 'Starting…' : 'Allow and run'}
          </button>
        )}
        <button
          type="button"
          className="cp-btn"
          onClick={onCancel}
          disabled={sending}
        >
          {plan.supported ? 'Cancel' : 'Close'}
        </button>
      </div>
    </div>
  );
}

function JobResult({ job }: { job: DockerJob }) {
  const running = job.state === 'running';
  return (
    <div
      className={`cp-docker-job${job.state === 'failed' ? ' is-failed' : ''}`}
      role="status"
      aria-live="polite"
    >
      <p>
        {running && (
          <LoaderCircle className="cp-spin" size={13} aria-hidden="true" />
        )}
        {job.message}
      </p>
      {running && SLOW_STEPS.includes(job.step) && (
        <p className="cp-docker-hint">
          This usually takes a few minutes. You can keep using FullDots.
        </p>
      )}
      {job.state === 'failed' && job.output && (
        <details>
          <summary>Technical details</summary>
          <pre>
            <code>{job.output}</code>
          </pre>
        </details>
      )}
    </div>
  );
}
