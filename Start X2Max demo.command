#!/bin/bash
# Double-click this file in Finder to try the dashboard with a simulated ride (no trainer).
# Nothing from a demo ride is mixed into your FTP test results.
cd "$(dirname "$0")" || exit 1
bash scripts/start.sh --demo "$@"
code=$?
if [ $code -ne 0 ]; then
  echo
  read -r -p "The logger stopped with an error (see above). Press Return to close."
fi
exit $code
