param(
    [string]$ComfyRoot = 'D:\Tools\ComfyUIWorkfiles',
    [string]$UpscaledPath = '',
    [switch]$Approve
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path

if ([string]::IsNullOrWhiteSpace($UpscaledPath)) {
    $searchRoot = Join-Path $ComfyRoot 'output'
    $candidate = Get-ChildItem -LiteralPath $searchRoot -Filter 'aika_front_master_4k*.png' -File -Recurse -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($null -eq $candidate) {
        throw "No SeedVR2 master output was found under $searchRoot. Run Aika_01 first or pass -UpscaledPath explicitly."
    }
    $UpscaledPath = $candidate.FullName
}

$resolvedSource = (Resolve-Path -LiteralPath $UpscaledPath).Path
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if ($Approve) {
    $projectTarget = Join-Path $projectRoot 'output\live2d\source\aika-front-master-4k.png'
    $comfyTarget = Join-Path $ComfyRoot 'input\aika\aika-front-master-4k.png'
}
else {
    $projectTarget = Join-Path $projectRoot "output\live2d\candidates\aika-front-master-4k-seedvr-$stamp.png"
    $comfyTarget = Join-Path $ComfyRoot 'input\aika\aika-front-master-4k-candidate.png'
}

New-Item -ItemType Directory -Path (Split-Path -Parent $projectTarget) -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $comfyTarget) -Force | Out-Null
Copy-Item -LiteralPath $resolvedSource -Destination $projectTarget -Force
Copy-Item -LiteralPath $resolvedSource -Destination $comfyTarget -Force

if ($Approve) {
    $installedWorkflowRoot = Join-Path $ComfyRoot 'user\default\workflows\Aika_Live2D'
    foreach ($name in @('Aika_02_Expression_Reference_Qwen2509.json', 'Aika_03_Base_Cutout_RemBgUltra.json')) {
        $path = Join-Path $installedWorkflowRoot $name
        if (-not (Test-Path -LiteralPath $path)) {
            continue
        }
        $workflow = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        $load = $workflow.nodes | Where-Object type -eq 'LoadImage' | Select-Object -First 1
        $load.widgets_values = @('aika/aika-front-master-4k.png', 'image')
        $workflow | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $path -Encoding utf8
    }
}

if ($Approve) {
    Write-Output "Approved high-resolution master: $projectTarget"
    Write-Output "Updated ComfyUI approved input: $comfyTarget"
}
else {
    Write-Output "Saved review candidate without replacing the approved master: $projectTarget"
    Write-Output "Review the face and layer edges, then rerun with -Approve -UpscaledPath <candidate> when accepted."
}
