<#
.SYNOPSIS
Loads the desktop-pet .env file into the current PowerShell session.

.DESCRIPTION
Dot-source this script before starting a process that should receive the
project's local configuration:

    . .\tools\load-env.ps1
    npm run test:next:real

Only simple KEY=VALUE entries are supported. Blank lines and lines beginning
with # are ignored. Values may be wrapped in single or double quotes.
#>

$ErrorActionPreference = 'Stop'
$envPath = Join-Path (Split-Path -Parent $PSScriptRoot) '.env'

if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
    throw "Missing $envPath. Copy .env.example to .env first."
}

foreach ($line in Get-Content -LiteralPath $envPath) {
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0 -or $trimmed.StartsWith('#')) {
        continue
    }

    $separator = $trimmed.IndexOf('=')
    if ($separator -lt 1) {
        throw "Invalid .env entry: $line"
    }

    $name = $trimmed.Substring(0, $separator).Trim()
    $value = $trimmed.Substring($separator + 1).Trim()
    if ($value.Length -ge 2) {
        $first = $value[0]
        $last = $value[$value.Length - 1]
        if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
            $value = $value.Substring(1, $value.Length - 2)
        }
    }

    Set-Item -Path "Env:$name" -Value $value
}

Write-Host "Loaded Aika environment from $envPath"
