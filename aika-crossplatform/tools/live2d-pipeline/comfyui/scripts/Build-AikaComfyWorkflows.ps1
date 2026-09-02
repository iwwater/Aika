param(
    [string]$ComfyRoot = 'D:\Tools\ComfyUIWorkfiles'
)

$ErrorActionPreference = 'Stop'

function Copy-JsonObject {
    param([Parameter(Mandatory)]$Value)
    return ($Value | ConvertTo-Json -Depth 100 | ConvertFrom-Json)
}

function Save-Workflow {
    param(
        [Parameter(Mandatory)]$Workflow,
        [Parameter(Mandatory)][string]$Path
    )

    $Workflow | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $Path -Encoding utf8
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$workflowOutput = Join-Path $projectRoot 'tools\live2d-pipeline\comfyui\workflows'
$seedVrExample = Join-Path $ComfyRoot 'custom_nodes\seedvr2_videoupscaler\example_workflows\SeedVR2_4K_image_upscale.json'
$rembgExample = Join-Path $ComfyRoot 'custom_nodes\comfyui_layerstyle\workflow\rembg_ultra_example.json'

if (-not (Test-Path -LiteralPath $seedVrExample)) {
    throw "Current SeedVR2 example workflow not found: $seedVrExample"
}
if (-not (Test-Path -LiteralPath $rembgExample)) {
    throw "LayerStyle RemBg example not found: $rembgExample"
}

New-Item -ItemType Directory -Path $workflowOutput -Force | Out-Null

$seedVrBase = Get-Content -LiteralPath $seedVrExample -Raw | ConvertFrom-Json
$loadTemplate = Copy-JsonObject ($seedVrBase.nodes | Where-Object type -eq 'LoadImage' | Select-Object -First 1)
$saveTemplate = Copy-JsonObject ($seedVrBase.nodes | Where-Object type -eq 'SaveImage' | Select-Object -First 1)
$noteTemplate = Copy-JsonObject ($seedVrBase.nodes | Where-Object type -eq 'Note' | Select-Object -First 1)

function New-AikaSeedVrWorkflow {
    param(
        [Parameter(Mandatory)][string]$InputImage,
        [Parameter(Mandatory)][string]$OutputPrefix,
        [Parameter(Mandatory)][string]$Note
    )

    $workflow = Copy-JsonObject $seedVrBase
    $load = $workflow.nodes | Where-Object type -eq 'LoadImage' | Select-Object -First 1
    $dit = $workflow.nodes | Where-Object type -eq 'SeedVR2LoadDiTModel' | Select-Object -First 1
    $vae = $workflow.nodes | Where-Object type -eq 'SeedVR2LoadVAEModel' | Select-Object -First 1
    $upscaler = $workflow.nodes | Where-Object type -eq 'SeedVR2VideoUpscaler' | Select-Object -First 1
    $save = $workflow.nodes | Where-Object type -eq 'SaveImage' | Select-Object -First 1
    $noteNode = $workflow.nodes | Where-Object type -eq 'Note' | Select-Object -First 1

    $load.widgets_values = @($InputImage, 'image')
    $dit.widgets_values = @('seedvr2_ema_3b_fp8_e4m3fn.safetensors', 'cuda:0', 16, $true, 'cpu', $false, 'sdpa')
    $vae.widgets_values = @('ema_vae_fp16.safetensors', 'cuda:0', $true, 512, 64, $true, 512, 64, 'false', 'cpu', $false)
    $upscaler.widgets_values = @(20260901, 'fixed', 2048, 4096, 1, $false, 'lab', 0, 0, 0, 0, 'cpu', $false)
    $save.widgets_values = @($OutputPrefix)
    $noteNode.widgets_values = @($Note)

    return $workflow
}

# Workflow 01: memory-conscious 4K master upscale from the approved 512x1024 front crop.
$upscaleWorkflow = New-AikaSeedVrWorkflow `
    -InputImage 'aika/aika-front-master-v1.png' `
    -OutputPrefix 'aika/live2d/master/aika_front_master_4k' `
    -Note 'Aika / Live2D / 01 master upscale. Current SeedVR2 nodes, 3B FP8, 16 swapped blocks, tiled VAE 512/64, short edge 2048, max edge 4096. Inspect the face after every run; generated facial highlights must not become the approved master.'

$upscalePath = Join-Path $workflowOutput 'Aika_01_Upscale_Front_Master_SeedVR2.json'
Save-Workflow -Workflow $upscaleWorkflow -Path $upscalePath

# Workflow 04: reusable upscaler for a manually corrected layer or reference asset.
$assetWorkflow = New-AikaSeedVrWorkflow `
    -InputImage 'aika/aika-front-master-v1.png' `
    -OutputPrefix 'aika/live2d/upscaled/aika_asset_4k' `
    -Note 'Aika / Live2D / 04 reusable asset upscale. Use only after a layer or reference image has passed identity and edge checks. Batch size remains 1 for the 8 GB GPU.'

$assetPath = Join-Path $workflowOutput 'Aika_04_Upscale_Single_Asset_SeedVR2.json'
Save-Workflow -Workflow $assetWorkflow -Path $assetPath

# Workflow 02: start from the official Qwen Image Edit 2509 template and bind it to local models.
$qwenTemplateUrl = 'https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/image_qwen_image_edit_2509.json'
$qwenTemp = Join-Path $env:TEMP 'aika_qwen_image_edit_2509_official.json'
Invoke-WebRequest -Uri $qwenTemplateUrl -OutFile $qwenTemp
$qwen = Get-Content -LiteralPath $qwenTemp -Raw | ConvertFrom-Json

$qwenLoad = $qwen.nodes | Where-Object type -eq 'LoadImage' | Select-Object -First 1
$qwenLoad.widgets_values = @('aika/aika-front-master-v1.png', 'image')

$qwenNote = $qwen.nodes | Where-Object type -eq 'MarkdownNote' | Select-Object -First 1
$qwenNote.widgets_values = @(
    "Aika / Live2D / 02 Expression and mouth reference`n`n" +
    "Select the latest approved front master in the LoadImage node. Paste one prompt from expression-presets.json. " +
    "Generate one expression at a time and reject any result that changes identity, glasses, hairstyle, outfit, pose, or framing."
)

$subgraph = $qwen.definitions.subgraphs[0]
$positive = $subgraph.nodes | Where-Object id -eq 111
$negative = $subgraph.nodes | Where-Object id -eq 110
$sampler = $subgraph.nodes | Where-Object id -eq 3
$unet = $subgraph.nodes | Where-Object id -eq 37
$clip = $subgraph.nodes | Where-Object id -eq 38
$vae = $subgraph.nodes | Where-Object id -eq 39
$lora = $subgraph.nodes | Where-Object id -eq 89

$positive.widgets_values = @(
    'Change only the facial expression to a gentle, warm closed-mouth smile. Preserve the exact identity, face proportions, glasses, eyes, blue-to-lavender hair, outfit, body, pose, framing, line art, and background. No white dots or holographic particles on facial skin.'
)
$negative.widgets_values = @(
    'identity drift, different face, changed glasses, changed hair, changed outfit, changed pose, cropped body, extra limbs, face sparkles, nose highlight, text, watermark'
)
$sampler.widgets_values[0] = 20260901
$sampler.widgets_values[1] = 'fixed'
$unet.widgets_values = @('qwen_image_edit_2509_fp8_e4m3fn.safetensors', 'default')
$clip.widgets_values = @('qwen_2.5_vl_7b_fp8_scaled.safetensors', 'qwen_image', 'default')
$vae.widgets_values = @('qwen_image_vae.safetensors')
$lora.widgets_values = @('Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors', 1)

# Use the locally confirmed core SaveImage node instead of the optional advanced saver.
$qwenSaveOld = $qwen.nodes | Where-Object id -eq 469
$qwenSave = Copy-JsonObject $saveTemplate
$qwenSave.id = 469
$qwenSave.pos = $qwenSaveOld.pos
$qwenSave.size = $qwenSaveOld.size
$qwenSave.order = $qwenSaveOld.order
$qwenSave.mode = 0
$qwenSave.inputs[0].link = 743
$qwenSave.widgets_values = @('aika/live2d/expressions/gentle_smile')
$qwen.nodes = @($qwen.nodes | Where-Object id -ne 469) + @($qwenSave)

$qwenPath = Join-Path $workflowOutput 'Aika_02_Expression_Reference_Qwen2509.json'
Save-Workflow -Workflow $qwen -Path $qwenPath

# Workflow 03: subject cutout and alpha mask. RemBgUltra may download its free weights on first run.
$rembgSource = Get-Content -LiteralPath $rembgExample -Raw | ConvertFrom-Json
$rembgTemplate = Copy-JsonObject ($rembgSource.nodes | Where-Object id -eq 29)

$cutLoad = Copy-JsonObject $loadTemplate
$cutLoad.id = 1
$cutLoad.pos = @(-720, 60)
$cutLoad.order = 0
$cutLoad.mode = 0
$cutLoad.outputs[0].links = @(1)
$cutLoad.widgets_values = @('aika/aika-front-master-4k.png', 'image')

$rembg = Copy-JsonObject $rembgTemplate
$rembg.id = 2
$rembg.pos = @(-300, 60)
$rembg.order = 1
$rembg.mode = 0
$rembg.inputs[0].link = 1
$rembg.outputs[0].links = @(2)
$rembg.outputs[1].links = @(3, 6)
$rembg.widgets_values = @(10, 0.01, 0.99, $true)

$invertMask = [ordered]@{
    id = 3
    type = 'InvertMask'
    pos = @(60, 80)
    size = @(220, 80)
    flags = @{}
    order = 2
    mode = 0
    inputs = @([ordered]@{ name = 'mask'; type = 'MASK'; link = 3 })
    outputs = @([ordered]@{ name = 'MASK'; type = 'MASK'; links = @(4) })
    properties = @{ 'Node name for S&R' = 'InvertMask'; cnr_id = 'comfy-core' }
    widgets_values = @()
}

$joinAlpha = [ordered]@{
    id = 4
    type = 'JoinImageWithAlpha'
    pos = @(340, 20)
    size = @(260, 100)
    flags = @{}
    order = 3
    mode = 0
    inputs = @(
        [ordered]@{ name = 'image'; type = 'IMAGE'; link = 2 },
        [ordered]@{ name = 'alpha'; type = 'MASK'; link = 4 }
    )
    outputs = @([ordered]@{ name = 'IMAGE'; type = 'IMAGE'; links = @(5) })
    properties = @{ 'Node name for S&R' = 'JoinImageWithAlpha'; cnr_id = 'comfy-core' }
    widgets_values = @()
}

$cutSave = Copy-JsonObject $saveTemplate
$cutSave.id = 5
$cutSave.pos = @(680, -40)
$cutSave.order = 5
$cutSave.mode = 0
$cutSave.inputs[0].link = 5
$cutSave.widgets_values = @('aika/live2d/layers/00_character_cutout_rgba')

$maskToImage = [ordered]@{
    id = 6
    type = 'MaskToImage'
    pos = @(340, 230)
    size = @(260, 80)
    flags = @{}
    order = 4
    mode = 0
    inputs = @([ordered]@{ name = 'mask'; type = 'MASK'; link = 6 })
    outputs = @([ordered]@{ name = 'IMAGE'; type = 'IMAGE'; links = @(7) })
    properties = @{ 'Node name for S&R' = 'MaskToImage'; cnr_id = 'comfy-core' }
    widgets_values = @()
}

$maskSave = Copy-JsonObject $saveTemplate
$maskSave.id = 7
$maskSave.pos = @(680, 220)
$maskSave.order = 6
$maskSave.mode = 0
$maskSave.inputs[0].link = 7
$maskSave.widgets_values = @('aika/live2d/layers/00_character_mask')

$cutNote = Copy-JsonObject $noteTemplate
$cutNote.id = 8
$cutNote.pos = @(-720, -250)
$cutNote.size = @(760, 210)
$cutNote.order = 7
$cutNote.mode = 0
$cutNote.widgets_values = @(
    "Aika / Live2D / 03 Base cutout`n`n" +
    "This produces the whole-character RGBA cutout and a foreground-white mask. The RemBg mask is inverted only on the JoinImageWithAlpha branch because the core alpha node uses mask semantics. " +
    "This is only the base silhouette; facial, hair, clothing, and occlusion layers still require the parts manifest and manual PSD cleanup."
)

$cutoutWorkflow = [ordered]@{
    last_node_id = 8
    last_link_id = 7
    nodes = @($cutLoad, $rembg, $invertMask, $joinAlpha, $cutSave, $maskToImage, $maskSave, $cutNote)
    links = @(
        @(1, 1, 0, 2, 0, 'IMAGE'),
        @(2, 2, 0, 4, 0, 'IMAGE'),
        @(3, 2, 1, 3, 0, 'MASK'),
        @(4, 3, 0, 4, 1, 'MASK'),
        @(5, 4, 0, 5, 0, 'IMAGE'),
        @(6, 2, 1, 6, 0, 'MASK'),
        @(7, 6, 0, 7, 0, 'IMAGE')
    )
    groups = @()
    config = @{}
    extra = @{ ds = @{ scale = 0.9; offset = @(@(-20), @(140)) } }
    version = 0.4
}

$cutoutPath = Join-Path $workflowOutput 'Aika_03_Base_Cutout_RemBgUltra.json'
Save-Workflow -Workflow $cutoutWorkflow -Path $cutoutPath

Write-Output "Generated: $upscalePath"
Write-Output "Generated: $qwenPath"
Write-Output "Generated: $cutoutPath"
Write-Output "Generated: $assetPath"
