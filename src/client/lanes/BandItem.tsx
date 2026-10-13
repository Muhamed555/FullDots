// One band item of the transcript: a lead's start_team_run (or a direct chat's dispatch line) draws
// its team run's band; delegate_to_dot and check_delegation calls draw the hand-off band.
import type { ToolCall } from '@ag-ui/core';
import { isTeamRunTool } from '../../shared/lanes';
import { TeamRunBand } from './TeamRunBand';
import { WorkBand } from './WorkBand';

export function BandItem({
  calls,
  results,
}: {
  calls: ToolCall[];
  results: ReadonlyMap<string, string>;
}) {
  const runs = calls.filter((call) => isTeamRunTool(call.function.name));
  if (!runs.length) return <WorkBand calls={calls} results={results} />;
  const rest = calls.filter((call) => !isTeamRunTool(call.function.name));
  return (
    <>
      {runs.map((call) => (
        <TeamRunBand key={call.id} call={call} result={results.get(call.id)} />
      ))}
      {rest.length > 0 && <WorkBand calls={rest} results={results} />}
    </>
  );
}
