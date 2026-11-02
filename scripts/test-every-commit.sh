#!/usr/bin/env bash
#
# Run the test suite at every commit in a range, not just at the tip.
#
# `npm test` at the tip proves the branch works; it does not prove the commits
# underneath it do. A commit that cannot pass the suite on its own makes
# `git bisect` blame a bystander, so this walks the range oldest-first and stops
# at the first commit that fails.
#
# usage: scripts/test-every-commit.sh [<range>]
#
#   <range> is anything `git rev-list` accepts: "a..b", "HEAD~3..HEAD", or a
#   single revision to check every commit reachable from it. It defaults to
#   "HEAD~1..HEAD".
#
# Each commit is checked out in a throwaway worktree under the system temp
# directory, so the checkout you are working in is never modified and the files
# the suite writes die with the worktree. Commits that share their tree with the
# commit before them (an empty merge, a revert and re-apply) are skipped, since
# the suite cannot tell them apart.
set -uo pipefail

range="${1:-HEAD~1..HEAD}"

if ! commits=$(git rev-list --reverse "$range" 2>/dev/null); then
  echo "cannot resolve range \"$range\"" >&2
  exit 2
fi

if [ -z "$commits" ]; then
  echo "No commits to check in $range."
  exit 0
fi

repo=$(git rev-parse --show-toplevel) || exit 2
scratch=$(mktemp -d "${TMPDIR:-/tmp}/doubloom-commits.XXXXXX") || exit 2
logs="$scratch/logs"
mkdir -p "$logs"
: > "$scratch/worktrees"

cleanup() {
  # Only the worktrees this run added: paths are recorded as they are created.
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    git -C "$repo" worktree remove --force "$dir" >/dev/null 2>&1 || true
  done < "$scratch/worktrees"
  git -C "$repo" worktree prune >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT

total=$(printf '%s\n' "$commits" | wc -l | tr -d ' ')
echo "Checking $total commit(s) in $range, oldest first."
echo

index=0
checked=0
last_tree=""
for sha in $commits; do
  index=$((index + 1))
  short=$(git rev-parse --short=8 "$sha")
  subject=$(git log -1 --format=%s "$sha")
  tree=$(git rev-parse "$sha^{tree}")

  if [ "$tree" = "$last_tree" ]; then
    printf '[%d/%d] %s  skipped: same tree as the commit before it  %s\n' \
      "$index" "$total" "$short" "$subject"
    continue
  fi
  last_tree=$tree

  dir="$scratch/wt-$short"
  echo "$dir" >> "$scratch/worktrees"

  if ! git -C "$repo" worktree add --detach "$dir" "$sha" >"$logs/add-$short.log" 2>&1; then
    printf '[%d/%d] %s  could not check the commit out  %s\n' \
      "$index" "$total" "$short" "$subject"
    sed 's/^/    /' "$logs/add-$short.log"
    exit 1
  fi

  started=$SECONDS
  ( cd "$dir" && npm test ) > "$logs/$short.log" 2>&1
  status=$?
  elapsed=$((SECONDS - started))
  checked=$((checked + 1))

  if [ "$status" -ne 0 ]; then
    printf '[%d/%d] %s  FAILED after %ds  %s\n' \
      "$index" "$total" "$short" "$elapsed" "$subject"
    # The failing tests and the totals, not the whole log: the rest is noise in
    # a CI console, and the commit is named above.
    grep -E '^not ok |^# (pass|fail) |^# Subtest' "$logs/$short.log" \
      | head -n 20 | sed 's/^/    /'
    echo
    echo "The suite fails at $short (\"$subject\"), so later commits cannot be"
    echo "bisected. Fix that commit first; the commits after it are unchecked."
    exit 1
  fi

  printf '[%d/%d] %s  ok in %ds  %s\n' \
    "$index" "$total" "$short" "$elapsed" "$subject"
done

echo
echo "All $checked commit(s) in $range pass on their own."
