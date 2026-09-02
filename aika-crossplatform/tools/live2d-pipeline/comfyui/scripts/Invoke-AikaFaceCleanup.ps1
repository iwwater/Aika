param(
    [string]$ComfyRoot = 'D:\Tools\ComfyUIWorkfiles',
    [string]$ComfyUrl = 'http://127.0.0.1:8188',
    [string]$SourcePath = '',
    [switch]$Approve
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
if ([string]::IsNullOrWhiteSpace($SourcePath)) {
    $SourcePath = Join-Path $projectRoot 'output\live2d\rejected\source-tests\aika-front-master-4k-seedvr-white-dots.png'
}
$resolvedSource = (Resolve-Path -LiteralPath $SourcePath).Path

Add-Type -AssemblyName System.Drawing
$sourceImage = [System.Drawing.Bitmap]::FromFile($resolvedSource)
try {
    if ($sourceImage.Width -ne 2048 -or $sourceImage.Height -ne 4096) {
        throw "Face cleanup is calibrated for 2048x4096, got $($sourceImage.Width)x$($sourceImage.Height)."
    }
}
finally {
    $sourceImage.Dispose()
}

$inputRoot = Join-Path $ComfyRoot 'input\aika'
New-Item -ItemType Directory -Path $inputRoot -Force | Out-Null
$inputName = 'aika/aika-face-cleanup-source.png'
Copy-Item -LiteralPath $resolvedSource -Destination (Join-Path $inputRoot 'aika-face-cleanup-source.png') -Force

$noseColor = [Convert]::ToInt32('F8E6DC', 16)
$mouthColor = [Convert]::ToInt32('F8E9E1', 16)
$prompt = [ordered]@{
    '1' = @{ class_type = 'LoadImage'; inputs = @{ image = $inputName } }
    '2' = @{ class_type = 'EmptyImage'; inputs = @{ width = 19; height = 20; batch_size = 1; color = $noseColor } }
    '3' = @{ class_type = 'SolidMask'; inputs = @{ value = 1.0; width = 19; height = 20 } }
    '4' = @{ class_type = 'FeatherMask'; inputs = @{ mask = @('3', 0); left = 4; top = 4; right = 4; bottom = 4 } }
    '5' = @{ class_type = 'ImageCompositeMasked'; inputs = @{ destination = @('1', 0); source = @('2', 0); x = 1195; y = 636; resize_source = $false; mask = @('4', 0) } }
    '6' = @{ class_type = 'EmptyImage'; inputs = @{ width = 29; height = 22; batch_size = 1; color = $mouthColor } }
    '7' = @{ class_type = 'SolidMask'; inputs = @{ value = 1.0; width = 29; height = 22 } }
    '8' = @{ class_type = 'FeatherMask'; inputs = @{ mask = @('7', 0); left = 4; top = 4; right = 4; bottom = 4 } }
    '9' = @{ class_type = 'ImageCompositeMasked'; inputs = @{ destination = @('5', 0); source = @('6', 0); x = 1191; y = 697; resize_source = $false; mask = @('8', 0) } }
    '10' = @{ class_type = 'SaveImage'; inputs = @{ images = @('9', 0); filename_prefix = 'aika/live2d/face-cleanup/aika-front-master-4k-clean' } }
}

$body = @{ prompt = $prompt; client_id = [guid]::NewGuid().ToString() } | ConvertTo-Json -Depth 30
$queued = Invoke-RestMethod -Uri "$ComfyUrl/prompt" -Method Post -ContentType 'application/json' -Body $body
$promptId = $queued.prompt_id
$historyItem = $null
for ($attempt = 0; $attempt -lt 120; $attempt++) {
    Start-Sleep -Milliseconds 500
    $history = Invoke-RestMethod -Uri "$ComfyUrl/history/$promptId"
    if ($history.PSObject.Properties.Name -contains $promptId) {
        $historyItem = $history.$promptId
        if ($historyItem.status.completed) {
            break
        }
    }
}
if ($null -eq $historyItem -or -not $historyItem.status.completed) {
    throw "ComfyUI face cleanup timed out: $promptId"
}

$saved = $historyItem.outputs.'10'.images[0]
$comfyOutput = Join-Path (Join-Path $ComfyRoot 'output') (Join-Path $saved.subfolder $saved.filename)
if (-not (Test-Path -LiteralPath $comfyOutput)) {
    throw "ComfyUI reported an output that does not exist: $comfyOutput"
}

if ($Approve) {
    $projectTarget = Join-Path $projectRoot 'output\live2d\source\aika-front-master-4k.png'
    $comfyTarget = Join-Path $inputRoot 'aika-front-master-4k.png'
}
else {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $projectTarget = Join-Path $projectRoot "output\live2d\candidates\aika-front-master-4k-clean-$stamp.png"
    $comfyTarget = Join-Path $inputRoot 'aika-front-master-4k-clean-candidate.png'
}

New-Item -ItemType Directory -Path (Split-Path -Parent $projectTarget) -Force | Out-Null
Copy-Item -LiteralPath $comfyOutput -Destination $projectTarget -Force
Copy-Item -LiteralPath $comfyOutput -Destination $comfyTarget -Force

if ($Approve) {
    Write-Output "Approved cleaned 4K master: $projectTarget"
    Write-Output 'Rerun Aika_03_Base_Cutout_RemBgUltra.json so the RGBA cutout uses this master.'
}
else {
    Write-Output "Saved cleaned review candidate: $projectTarget"
    Write-Output 'Inspect the face at 100% before rerunning with -Approve.'
}
