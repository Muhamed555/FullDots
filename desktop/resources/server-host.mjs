// Runs the FullDots server inside Electron's utility process.
//
// The server is the same build the web deployment runs (dist/server/server/index.js); nothing in
// it knows about the desktop. This file only adds a way to stop it: Windows has no SIGTERM to send
// a child, so the shell posts a message and the server's own SIGTERM handler does the rest (stops
// the scheduler and channels, closes the database, exits).
import { pathToFileURL } from 'node:url';

const entry = process.env.FULLDOTS_SERVER_ENTRY;
if (!entry) throw new Error('FULLDOTS_SERVER_ENTRY is not set.');

process.parentPort?.on('message', (event) => {
  if (event.data === 'shutdown') process.emit('SIGTERM', 'SIGTERM');
});

await import(pathToFileURL(entry).href);
