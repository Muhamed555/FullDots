# A desktop for Dot computers, built on the pinned computer image. OpenBot starts its own virtual
# display (Xvfb, 1280x800) in headed mode; this adds the Openbox window manager on that display,
# xdotool and wmctrl for input and windows, ImageMagick for pictures of the screen, and two small
# apps. FullDots drives all of it through the computer's existing shell call.
FROM opendots-computer:b6932d3
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      xvfb openbox xdotool wmctrl imagemagick mousepad xterm \
      fonts-dejavu-core dbus-x11 \
  && rm -rf /var/lib/apt/lists/*
COPY deployment/computers/desktop-session.sh /usr/local/bin/desktop-session
# Normalised here too, so a checkout with Windows line endings still builds a working script.
RUN sed -i 's/\r$//' /usr/local/bin/desktop-session \
  && chmod 0755 /usr/local/bin/desktop-session
# Headed, so OpenBot starts the display; DISPLAY is passed to shell commands, which run with an
# allow-listed environment.
ENV COMPUTER_BROWSER_MODE=headed \
    COMPUTER_SHELL_ENV=DISPLAY
CMD ["/usr/local/bin/desktop-session"]
