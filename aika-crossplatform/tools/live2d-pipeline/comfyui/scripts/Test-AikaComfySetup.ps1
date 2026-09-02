param(
    [string]$ComfyRoot = 'D:\Tools\ComfyUIWorkfiles',
    [string]$ComfyUrl = 'http://127.0.0.1:8188'
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$workflowSource = Join-Path $projectRoot 'tools\live2d-pipeline\comfyui\workflows'
$workflowTarget = Join-Path $ComfyRoot 'user\default\workflows\Aika_Live2D'

$objectInfo = Invoke-RestMethod -Uri "$ComfyUrl/object_info"
$requiredNodes = @(
    'LoadImage',
    'SaveImage',
    'SeedVR2LoadDiTModel',
    'SeedVR2LoadVAEModel',
    'SeedVR2VideoUpscaler',
    'LayerMask: RemBgUltra',
    'InvertMask',
    'JoinImageWithAlpha',
    'MaskToImage',
    'SeeThrough_LoadLayerDiffModel',
    'SeeThrough_LoadDepthModel',
    'SeeThrough_GenerateLayers',
    'SeeThrough_GenerateDepth',
    'SeeThrough_PostProcess',
    'SeeThrough_SavePSD'
)

$missingNodes = @($requiredNodes | Where-Object { $objectInfo.PSObject.Properties.Name -notcontains $_ })
if ($missingNodes.Count -gt 0) {
    throw "Missing ComfyUI nodes: $($missingNodes -join ', ')"
}

$workflowFiles = Get-ChildItem -LiteralPath $workflowSource -Filter 'Aika_*.json' -File
if ($workflowFiles.Count -ne 5) {
    throw "Expected five Aika workflows, found $($workflowFiles.Count)."
}

foreach ($file in $workflowFiles) {
    $workflow = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
    if ($null -eq $workflow.nodes -or $workflow.nodes.Count -eq 0) {
        throw "Workflow has no root nodes: $($file.Name)"
    }

    $installed = Join-Path $workflowTarget $file.Name
    if (-not (Test-Path -LiteralPath $installed)) {
        throw "Workflow is not installed: $installed"
    }

    $sourceHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    $installedHash = (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash
    if ($sourceHash -ne $installedHash) {
        throw "Installed workflow is out of date: $($file.Name)"
    }
}

$upscale = Get-Content -LiteralPath (Join-Path $workflowSource 'Aika_01_Upscale_Front_Master_SeedVR2.json') -Raw | ConvertFrom-Json
$upscaleTypes = @($upscale.nodes.type)
foreach ($type in @('SeedVR2LoadDiTModel', 'SeedVR2LoadVAEModel', 'SeedVR2VideoUpscaler')) {
    if ($upscaleTypes -notcontains $type) {
        throw "Upscale workflow does not use current node: $type"
    }
}

$cutout = Get-Content -LiteralPath (Join-Path $workflowSource 'Aika_03_Base_Cutout_RemBgUltra.json') -Raw | ConvertFrom-Json
if (@($cutout.nodes.type) -notcontains 'InvertMask') {
    throw 'Cutout workflow is missing InvertMask; RGBA alpha would be reversed.'
}

$seeThrough = Get-Content -LiteralPath (Join-Path $workflowSource 'Aika_05_SeeThrough_Decompose_8GB.json') -Raw | ConvertFrom-Json
$seeThroughTypes = @($seeThrough.nodes.type)
foreach ($type in @('SeeThrough_LoadLayerDiffModel', 'SeeThrough_LoadDepthModel', 'SeeThrough_GenerateLayers', 'SeeThrough_GenerateDepth', 'SeeThrough_PostProcess', 'SeeThrough_SavePSD')) {
    if ($seeThroughTypes -notcontains $type) {
        throw "SeeThrough workflow is missing node: $type"
    }
}

Add-Type -AssemblyName System.Drawing
$masterPath = Join-Path $projectRoot 'output\live2d\source\aika-front-master-4k.png'
$cutoutPath = Join-Path $projectRoot 'output\live2d\layers\00-character-cutout-rgba.png'
foreach ($path in @($masterPath, $cutoutPath)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Required output is missing: $path"
    }
    $image = [System.Drawing.Bitmap]::FromFile($path)
    try {
        if ($image.Width -ne 2048 -or $image.Height -ne 4096) {
            throw "Unexpected image size for ${path}: $($image.Width)x$($image.Height)"
        }
    }
    finally {
        $image.Dispose()
    }
}

Write-Output 'Aika ComfyUI setup is healthy.'
Write-Output "Server: $ComfyUrl"
Write-Output "Workflows: $($workflowFiles.Count) installed and hash-matched"
Write-Output 'Outputs: approved 2048x4096 master and RGBA cutout present'
