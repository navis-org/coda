#!/bin/zsh
#
# Lean vs full catalogue, against whichever provider the assistant is set up for.
#
# The question this answers cannot be answered by reading the diff: `lean` drops what every
# param *means* and keeps only what a plan can be refused for, which is 45% of the prompt. All
# the evidence so far is one 27B local model — `qwen3.8:latest`, where lean scored 39/40 against
# full's 37/40 and was never worse. The shipped default provider is Sonnet 5, and whether the
# prose matters is a question about the model reading it.
#
# Usage, from the repo root, in a shell where ANTHROPIC_API_KEY is exported:
#
#   ./scripts/compare-catalogue.sh                 # 3 reps of each level
#   REPS=1 ./scripts/compare-catalogue.sh          # a quicker look
#
# Costs real tokens: 7 questions per suite run, 2 levels, REPS reps — 42 requests at the
# default. The per-turn token counts are printed, so read those rather than guessing.
#
# Writes to compare-catalogue.log in the repo root and prints a tally at the end.

set -e
cd "$(dirname "$0")/.."

if [[ -z "$ANTHROPIC_API_KEY" ]]; then
  echo "ANTHROPIC_API_KEY is not set — the suite would skip itself silently." >&2
  exit 1
fi

REPS=${REPS:-3}
LOG=compare-catalogue.log
: > $LOG

for rep in $(seq 1 $REPS); do
  for level in full lean; do
    echo "########## rep $rep :: $level" >> $LOG
    CODA_ASSISTANT_CATALOGUE=$level npx vitest run src/assistant/live.test.ts 2>&1 \
      | grep -vE '^\s*$|^ RUN|node:|ExperimentalWarning|trace-warnings' >> $LOG
  done
done

echo
echo "=== pass/fail by level ==="
awk '/^##########/{split($0,a," "); l=a[5]} /^   [✓×]/{print l" "$1}' $LOG | sort | uniq -c

echo
echo "=== failures ==="
grep '^   × ' $LOG | sed 's/against the real API > //' || echo "none"

echo
echo "=== refusals (a plan the applier rejected) ==="
grep -A4 REFUSED $LOG | grep -E 'REFUSED|^    ' || echo "none"

echo
echo "=== tokens per turn ==="
grep 'tokens:' $LOG | sort | uniq -c | sort -rn | head -20

echo
echo "Full transcript in $LOG — read the plan summaries, not just the tally."
