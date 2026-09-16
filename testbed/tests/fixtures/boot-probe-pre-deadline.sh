#!/usr/bin/env bash
# Test-only legacy shim: emulate the pre-fix placement that starts the deadline after contract resolution.
set -euo pipefail
shim_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
real_probe="$(cd "$shim_dir/../.." && pwd -P)/probes/boot-probe.sh"
legacy_helper="${CONTRACT_HELPER:?}"
legacy_plugin="${PLUGIN_DIR:?}"
legacy_work="${WORK_DIR:?}"
legacy_contract="$legacy_work/legacy-contract.json"
node "$legacy_helper" contract "$legacy_plugin" > "$legacy_contract"
exec env CONTRACT_HELPER="$legacy_helper" PLUGIN_DIR="$legacy_plugin" bash "$real_probe"
