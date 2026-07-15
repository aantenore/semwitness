#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -P "$(dirname "$0")" >/dev/null 2>&1 && pwd)
exec node "$SCRIPT_DIR/semwitness.mjs" "$@"
