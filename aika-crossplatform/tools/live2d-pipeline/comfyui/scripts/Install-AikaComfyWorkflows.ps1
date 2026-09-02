param(
    [string]$ComfyRoot = 'D:\Tools\ComfyUIWorkfiles'
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$workflowSource = Join-Path $projectRoot 'tools\live2d-pipeline\comfyui\workflows'
$workflowTarget = Join-Path $ComfyRoot 'user\default\workflows\Aika_Live2D'
$inputTarget = Join-Path $ComfyRoot 'input\aika'
$turnaroundSource = Join-Path $projectRoot 'output\character-concepts\aika-holographic-turnaround-v1-rebuild.png'
$frontSource = Join-Path $projectRoot 'output\live2d\source\aika-front-master-v1.png'
$front4kSource = Join-Path $projectRoot 'output\live2d\source\aika-front-master-4k.png'

if (-not (Test-Path -LiteralPath $ComfyRoot)) {
    throw "ComfyUI workspace not found: $ComfyRoot"
}
if (-not (Test-Path -LiteralPath $turnaroundSource)) {
    throw "Approved turnaround source not found: $turnaroundSource"
}

New-Item -ItemType Directory -Path $workflowTarget -Force | Out-Null
New-Item -ItemType Directory -Path $inputTarget -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $frontSource) -Force | Out-Null

Add-Type -AssemblyName System.Drawing
$sourceImage = [System.Drawing.Image]::FromFile($turnaroundSource)
try {
    if ($sourceImage.Width -ne 1536 -or $sourceImage.Height -ne 1024) {
        throw "Turnaround layout changed. Expected 1536x1024, got $($sourceImage.Width)x$($sourceImage.Height)."
    }

    $front = New-Object System.Drawing.Bitmap 512, 1024
    $graphics = [System.Drawing.Graphics]::FromImage($front)
    try {
        $graphics.DrawImage(
            $sourceImage,
            (New-Object System.Drawing.Rectangle 0, 0, 512, 1024),
            (New-Object System.Drawing.Rectangle 0, 0, 512, 1024),
            [System.Drawing.GraphicsUnit]::Pixel
        )
        $front.Save($frontSource, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $graphics.Dispose()
        $front.Dispose()
    }
}
finally {
    $sourceImage.Dispose()
}

Copy-Item -LiteralPath $turnaroundSource -Destination (Join-Path $inputTarget 'aika-turnaround-v1-rebuild.png') -Force
Copy-Item -LiteralPath $frontSource -Destination (Join-Path $inputTarget 'aika-front-master-v1.png') -Force
if (Test-Path -LiteralPath $front4kSource) {
    Copy-Item -LiteralPath $front4kSource -Destination (Join-Path $inputTarget 'aika-front-master-4k.png') -Force
}
Get-ChildItem -LiteralPath $workflowSource -Filter '*.json' | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $workflowTarget $_.Name) -Force
}

Write-Output "Installed workflows: $workflowTarget"
Write-Output "Installed inputs: $inputTarget"
Write-Output "Front master crop: $frontSource"
