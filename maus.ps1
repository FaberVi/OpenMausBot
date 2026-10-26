& (Join-Path $PSScriptRoot 'deploy\local\docker-compose.ps1') @args
exit $LASTEXITCODE
