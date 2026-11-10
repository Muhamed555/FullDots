// Finds a port the server can listen on.
import { createServer } from 'node:net';

function free(port: number, host: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', () => resolve(undefined));
    probe.listen({ port, host, exclusive: true }, () => {
      const address = probe.address();
      const found =
        typeof address === 'object' && address ? address.port : port;
      probe.close(() => resolve(found));
    });
  });
}

/**
 * The preferred port when it is free, else the next few after it, else any free port. Staying near
 * the preferred one keeps the page's origin, and with it the saved theme and sign-in redirects.
 */
export async function findPort(
  preferred: number,
  host = '127.0.0.1',
  span = 10,
): Promise<number> {
  for (
    let port = preferred;
    port < preferred + span && port <= 65535;
    port += 1
  ) {
    const found = await free(port, host);
    if (found) return found;
  }
  const any = await free(0, host);
  if (!any) throw new Error('No free port to start FullDots on.');
  return any;
}
