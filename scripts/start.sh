#!/usr/bin/env bash
# Start the X2Max logger and open the dashboard, with everything it needs done first:
#
#   scripts/start.sh            ride with the trainer
#   scripts/start.sh --demo     simulated ride, no trainer needed
#   scripts/start.sh --phone    also open the dashboard on a phone on the same Wi-Fi
#
# Before starting it
#   1. updates the code (git pull, only on main with no local changes; --no-update skips it),
#   2. installs the Python packages (uv, from uv.lock),
#   3. rebuilds dashboard/dashboard.html if its source changed and pnpm is installed,
#   4. says which optional features are off because a .env key is missing.
# The logger picks a free port itself (8000, or the next one if e.g. Docker has 8000).
# Every other option goes to the logger: see  uv run logger/thinkrider_logger.py --help
#
# Everything is inside main(), so a git pull that changes this file can't trip up the run.

main() {
  set -u
  cd "$(dirname "$0")/.." || exit 1
  # Finder (the .command launchers) starts without your shell profile.
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

  local update=1 rebuild=0 args=()
  for a in "$@"; do
    case "$a" in
      --no-update) update=0 ;;
      --rebuild) rebuild=1 ;;
      --phone) args+=(--host 0.0.0.0) ;;
      -h|--help) usage; echo; echo "Logger options:"
        uv run --quiet logger/thinkrider_logger.py --help; return 0 ;;
      *) args+=("$a") ;;
    esac
  done

  if ! command -v uv >/dev/null 2>&1; then
    echo "uv is not installed. Install it from https://docs.astral.sh/uv/ and try again."
    return 1
  fi

  [ "$update" = 1 ] && update_code
  echo "Checking Python packages..."
  uv sync --quiet || { echo "uv sync failed (see above)."; return 1; }
  build_dashboard "$rebuild" || return 1
  check_env

  echo
  exec uv run --quiet logger/thinkrider_logger.py "${args[@]+"${args[@]}"}"
}

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
}

# git pull, but only when it can't get in the way: on main, tracking a remote, nothing
# uncommitted. Offline or anything unexpected: say so and carry on with the code you have.
update_code() {
  command -v git >/dev/null 2>&1 && [ -d .git ] || return 0
  local branch
  branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || return 0
  if [ "$branch" != "main" ]; then
    echo "On branch $branch: not updating (only main is pulled automatically)."
    return 0
  fi
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "You have local changes: not updating. Commit or stash them to get the latest code."
    return 0
  fi
  git rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1 || return 0
  echo "Getting the latest code..."
  local before
  before=$(git rev-parse HEAD)
  if ! git pull --ff-only --quiet; then
    echo "Couldn't update (offline?). Starting with the code you have."
    return 0
  fi
  if [ "$(git rev-parse HEAD)" != "$before" ]; then
    echo "Updated:"
    git log --oneline --no-decorate "$before..HEAD" | sed 's/^/  /'
  fi
}

# The built dashboard.html is committed, so this only matters when dashboard/src was edited
# here. Rebuild when a source file is newer than dashboard.html (or with --rebuild).
build_dashboard() {
  local html=dashboard/dashboard.html
  if [ "$1" != 1 ] && [ -f "$html" ] && [ -z "$(find dashboard/src dashboard/build.mjs \
      dashboard/package.json dashboard/pnpm-lock.yaml -newer "$html" -print -quit 2>/dev/null)" ]; then
    return 0
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    if [ -f "$html" ]; then
      echo "Dashboard source changed but pnpm isn't installed: using the built dashboard.html."
      return 0
    fi
    echo "dashboard/dashboard.html is missing and pnpm isn't installed (https://pnpm.io/)."
    return 1
  fi
  echo "Building the dashboard..."
  (
    cd dashboard || exit 1
    pnpm install --frozen-lockfile --silent && pnpm --silent build
  ) || { echo "The dashboard build failed (see above)."; return 1; }
}

# Optional features and the .env key each one needs. Values are never printed.
check_env() {
  local missing=()
  has_key ANTHROPIC_API_KEY || missing+=("Ask Claude (ANTHROPIC_API_KEY)")
  has_key GARMIN_API_KEY || missing+=("Garmin rides and context (GARMIN_API_KEY)")
  [ ${#missing[@]} -eq 0 ] && return 0
  echo "Optional, off until the key is in .env:"
  printf '  %s\n' "${missing[@]}"
}

has_key() {
  [ -n "${!1:-}" ] && return 0
  [ -f .env ] && grep -Eq "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*[^[:space:]#]" .env
}

main "$@"
exit $?
