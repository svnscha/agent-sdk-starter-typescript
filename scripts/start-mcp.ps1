param([int]$Port = 8000)
$ErrorActionPreference = 'Stop'
$demoRoot = Split-Path -Parent $PSScriptRoot
$symbolCache = Join-Path $demoRoot '.work\symbols'
New-Item -ItemType Directory -Force -Path $symbolCache | Out-Null

# Keep the unauthenticated debugger endpoint on loopback.
uvx --from mcp-windbg==1.5.1 mcp-windbg --transport streamable-http --host 127.0.0.1 --port $Port --symbols-path "srv*$symbolCache*https://msdl.microsoft.com/download/symbols"
exit $LASTEXITCODE
