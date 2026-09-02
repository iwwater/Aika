[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$workshopRoot = Split-Path -Parent $PSScriptRoot

function Find-Command {
    param([Parameter(Mandatory)][string[]]$Names)

    foreach ($name in $Names) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command) { return $command }
    }
    return $null
}

function Write-Check {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][bool]$Available,
        [Parameter(Mandatory)][string]$Detail,
        [bool]$Required = $true
    )

    $label = if ($Available) { "OK" } elseif ($Required) { "MISSING" } else { "OPTIONAL" }
    $color = if ($Available) { "Green" } elseif ($Required) { "Red" } else { "Yellow" }
    Write-Host ("[{0}] {1}: {2}" -f $label, $Name, $Detail) -ForegroundColor $color
}

Write-Host "Aika Voice Workshop - environment check" -ForegroundColor Cyan

$python = Find-Command -Names @("python", "py")
$pythonVersion = if ($python) { & $python.Source --version 2>&1 | Select-Object -First 1 } else { "Python 3.10+ is recommended" }
Write-Check -Name "Python" -Available ([bool]$python) -Detail ([string]$pythonVersion)

$git = Find-Command -Names @("git")
$gitVersion = if ($git) { & $git.Source --version 2>&1 | Select-Object -First 1 } else { "Install Git for training backend setup" }
Write-Check -Name "Git" -Available ([bool]$git) -Detail ([string]$gitVersion)

$ffmpeg = Find-Command -Names @("ffmpeg")
$ffmpegVersion = if ($ffmpeg) { (& $ffmpeg.Source -version 2>&1 | Select-Object -First 1) } else { "Required for audio preparation" }
Write-Check -Name "FFmpeg" -Available ([bool]$ffmpeg) -Detail ([string]$ffmpegVersion)

$nvidiaSmi = Find-Command -Names @("nvidia-smi")
$gpuDetail = if ($nvidiaSmi) {
    (& $nvidiaSmi.Source --query-gpu=name,memory.total --format=csv,noheader 2>&1 | Select-Object -First 1)
} else {
    "No NVIDIA GPU detected; CPU training is possible but much slower"
}
Write-Check -Name "NVIDIA GPU" -Available ([bool]$nvidiaSmi) -Detail ([string]$gpuDetail) -Required $false

foreach ($folderName in @("input", "workspace", "export")) {
    $folderPath = Join-Path $workshopRoot $folderName
    Write-Check -Name $folderName -Available (Test-Path -LiteralPath $folderPath -PathType Container) -Detail $folderPath
}

if ($python -and $git -and $ffmpeg) {
    Write-Host "`nBase environment is ready. Training dependencies will be installed when the training backend is added." -ForegroundColor Green
    exit 0
}

Write-Host "`nInstall the missing required tools, then run this check again." -ForegroundColor Yellow
exit 1
