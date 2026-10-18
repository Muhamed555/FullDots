#!/bin/sh
# Runs OpenBot's computer service, which starts its own virtual display, and keeps the Openbox
# window manager running on that display for as long as the service runs.
set -u

# A display left from before a restart would be mistaken for the new one.
rm -f /tmp/.X*-lock /tmp/.X11-unix/X* 2>/dev/null

bun src/index.ts &
service=$!
trap 'kill -TERM "$service" 2>/dev/null' TERM INT

(
  display=''
  for _ in $(seq 1 100); do
    socket=$(ls /tmp/.X11-unix 2>/dev/null | head -n 1)
    if [ -n "$socket" ]; then
      display=":${socket#X}"
      break
    fi
    sleep 0.1
  done
  if [ -z "$display" ]; then
    echo 'desktop-session: no display appeared; running without a window manager' >&2
    exit 0
  fi
  while kill -0 "$service" 2>/dev/null; do
    DISPLAY="$display" openbox >/dev/null 2>&1
    sleep 1
  done
) &

# `wait` returns early when a trapped signal arrives; then wait for the service's own exit.
wait "$service"
status=$?
if kill -0 "$service" 2>/dev/null; then
  wait "$service"
  status=$?
fi
exit "$status"
