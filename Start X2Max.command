#!/bin/bash
# Double-click this file in Finder to start the X2Max logger and open the dashboard.
# Pick the trainer and heart-rate device on the dashboard (click the status pills at the top).
# To stop: Settings > Stop logger, or close this window. A ride in progress is saved either way.
#
# Options for the logger go here, e.g. EXTRA_ARGS="--host 0.0.0.0" to also open the
# dashboard on your phone (same Wi-Fi), or EXTRA_ARGS="--demo" to try it without the trainer.
EXTRA_ARGS=""

cd "$(dirname "$0")" || exit 1
# Finder starts this without your shell profile, so add the usual places uv is installed.
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v uv >/dev/null 2>&1; then
  echo "uv is not installed. Install it from https://docs.astral.sh/uv/ and double-click again."
  read -r -p "Press Return to close."
  exit 1
fi
# shellcheck disable=SC2086
uv run logger/thinkrider_logger.py $EXTRA_ARGS "$@"
code=$?
if [ $code -ne 0 ]; then
  echo
  read -r -p "The logger stopped with an error (see above). Press Return to close."
fi
exit $code
