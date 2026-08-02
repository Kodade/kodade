#!/usr/bin/env bash
# Human-guided reproduction loop.
# Copy this file, replace the steps below, then run it with Bash.
# The agent runs the script while the user follows the prompts in a terminal.
#
# Helpers:
#   step "instruction"        Show an instruction and wait for Enter.
#   capture VAR "question"    Save the user's answer in VAR.
#
# Captured values are emitted as KEY=VALUE at the end for the agent to inspect.

set -euo pipefail

step() {
  printf '\n>>> %s\n' "$1"
  read -r -p "    [Press Enter when done] " _
}

capture() {
  local var="$1" question="$2" answer
  printf '\n>>> %s\n' "$question"
  read -r -p "    > " answer
  printf -v "$var" '%s' "$answer"
}

# --- Replace these example steps ---------------------------------------

step "Open the app at http://localhost:3000 and sign in."

capture ERRORED "Select Export. Did it throw an error? (y/n)"
capture ERROR_MESSAGE "Paste the error message, or enter none:"

# --- End example steps -------------------------------------------------

printf '\n--- Captured evidence ---\n'
printf 'ERRORED=%s\n' "$ERRORED"
printf 'ERROR_MESSAGE=%s\n' "$ERROR_MESSAGE"
