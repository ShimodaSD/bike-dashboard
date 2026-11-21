#!/bin/bash
# Double-click this file in Finder to start the X2Max logger and open the dashboard.
# It gets the latest code, installs what's needed and picks a free port (scripts/start.sh).
# Pick the trainer and heart-rate device on the dashboard (click the status pills at the top).
# To stop: Settings > Stop logger, or close this window. A ride in progress is saved either way.
#
# Options go here, e.g. EXTRA_ARGS="--phone" to also open the dashboard on your phone
# (same Wi-Fi). To try it without the trainer, double-click "Start X2Max demo.command".
EXTRA_ARGS=""

cd "$(dirname "$0")" || exit 1
# shellcheck disable=SC2086
bash scripts/start.sh $EXTRA_ARGS "$@"
code=$?
if [ $code -ne 0 ]; then
  echo
  read -r -p "The logger stopped with an error (see above). Press Return to close."
fi
exit $code
