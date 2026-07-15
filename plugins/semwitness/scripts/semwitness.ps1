$ErrorActionPreference = "Stop"

$launcher = Join-Path $PSScriptRoot "semwitness.mjs"
& node $launcher @args

if ($null -eq $LASTEXITCODE) {
    exit 1
}

exit $LASTEXITCODE
