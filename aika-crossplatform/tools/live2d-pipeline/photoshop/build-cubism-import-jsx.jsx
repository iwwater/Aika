// build-cubism-import-jsx.jsx
// 在 Photoshop 中生成 Cubism 导入用 PSD（透明底、每层唯一命名、顺序固定）。
//
// 用法：Photoshop → 文件 → 脚本 → 浏览 → 选择本文件
//   （或 令 PS 以 app.doJavaScript 调用，传入 LAYERS_DIR 环境变量不便，故用 CONFIG 常量）
//
// 输入：v2-layers 目录下的 53 个部件 PNG（2048x4096，已含归属夹缝像素）
// 输出：cubism-import-v2.psd + import-order.txt
//
// 为什么不直接把 PNG 逐层置入：Photoshop 的 PSD 才带真正的文档级透明，
// psd-tools 生成的 RGBA 容器第 4 通道会被当作额外通道而非文档 alpha。

#target photoshop

// ====== 配置（按需修改；路径用正斜杠或双反斜杠） ======
var CONFIG = {
    layersDir: "E:/Work/AI CHAT/aika-crossplatform/output/live2d/production-v1/v3-layers",
    outPsd:    "E:/Work/AI CHAT/aika-crossplatform/output/live2d/production-v1/v3/cubism-import-v3.psd",
    outList:   "E:/Work/AI CHAT/aika-crossplatform/output/live2d/production-v1/v3/cubism-import-layers-ps.txt",
    canvasW: 2048,
    canvasH: 4096
};

// 图层顺序：PSD 数组的**前**元素 = 视觉**最上**层。
// 取自 v1 PSD 实测顺序（背面在下、配件在上），已剔除残留层与参考层。
var TOP_TO_BOTTOM = [
    "halo_orbital",
    "glasses_bridge", "glasses_rim_screenLeft", "glasses_rim_screenRight",
    "chest_diamond",
    "brow_screenLeft", "brow_screenRight", "nose",
    "eye_highlight_screenLeft", "eye_highlight_screenRight",
    "eye_iris_screenLeft", "eye_iris_screenRight",
    "eye_lash_upper_screenLeft", "eye_lash_upper_screenRight",
    "eye_white_screenLeft", "eye_white_screenRight",
    "mouth_neutral",
    "bang_screenLeft_inner", "bang_screenRight_inner",
    "bang_screenLeft_outer", "bang_screenRight_outer",
    "hair_braid_screenLeft", "hair_braid_screenRight",
    "hair_sideLock_screenLeft", "hair_sideLock_screenRight",
    "face_skin", "forehead_skin",
    "ear_screenLeft", "ear_screenRight",
    "neck",
    "hand_screenLeft", "hand_screenRight",
    "cuff_screenLeft", "cuff_screenRight",
    "holo_sleeve_screenLeft", "holo_sleeve_screenRight",
    "jacket_sleeve_screenLeft", "jacket_sleeve_screenRight",
    "jacket_front_screenLeft", "jacket_front_screenRight",
    "holo_coattail_screenLeft", "holo_coattail_screenRight",
    "dress_front",
    "dress_back_screenLeft", "dress_back_screenRight",
    "boot_screenLeft", "boot_screenRight",
    "leg_screenLeft", "leg_screenRight",
    "hair_back_screenLeft_outer", "hair_back_screenRight_outer",
    "hair_back_screenLeft_lower", "hair_back_screenRight_lower"
];

function main() {
    var prevUnits = app.preferences.rulerUnits;
    app.preferences.rulerUnits = Units.PIXELS;

    var log = [];

    // 关掉同名旧文档，避免重复运行堆积
    for (var d = app.documents.length - 1; d >= 0; d--) {
        var dn = app.documents[d].name;
        if (dn.indexOf("cubism-import") === 0) {
            app.documents[d].close(SaveOptions.DONOTSAVECHANGES);
            log.push("closed stale doc: " + dn);
        }
    }

    // 确保输出目录存在（Photoshop 的 saveAs 不会自建目录）
    function ensureFolder(pathStr) {
        var parts = pathStr.split("/");
        var cur = parts[0] === "" ? "/" : parts[0];
        for (var i = 1; i < parts.length - 1; i++) {
            cur = cur + "/" + parts[i];
            var f = new Folder(cur);
            if (!f.exists) { f.create(); }
        }
    }
    ensureFolder(CONFIG.outPsd);

    // 新建透明底文档
    var doc = app.documents.add(
        CONFIG.canvasW, CONFIG.canvasH, 300, "cubism-import-v3",
        NewDocumentMode.RGB, DocumentFill.TRANSPARENT);

    // 从**最底层**开始置入：每置入一张，它成为新的顶层，
    // 因此按 TOP_TO_BOTTOM 的逆序处理。
    for (var i = TOP_TO_BOTTOM.length - 1; i >= 0; i--) {
        var name = TOP_TO_BOTTOM[i];
        var f = new File(CONFIG.layersDir + "/" + name + ".png");
        if (!f.exists) {
            log.push("MISSING: " + name);
            continue;
        }
        app.activeDocument = doc;
        var before = doc.layers.length;
        var idPlc = charIDToTypeID("Plc ");
        var desc = new ActionDescriptor();
        desc.putPath(charIDToTypeID("null"), f);
        desc.putEnumerated(charIDToTypeID("FTcs"), charIDToTypeID("QCSt"),
            charIDToTypeID("Qcsa"));  // 不改尺寸
        executeAction(idPlc, desc, DialogModes.NO);

        var placed = doc.activeLayer;
        // 置入后若被转成智能对象，栅格化以符合 Cubism 单像素层要求
        if (placed.kind == LayerKind.SMARTOBJECT) {
            placed.rasterize(RasterizeType.ENTIRELAYER);
        }
        placed.name = name;
        log.push("OK: " + name + " (layers=" + doc.layers.length + ", was=" + before + ")");
    }

    // 保存
    var opts = new PhotoshopSaveOptions();
    opts.alphaChannels = true;
    opts.layers = true;
    opts.embedColorProfile = true;
    opts.spotColors = true;
    doc.saveAs(new File(CONFIG.outPsd), opts, true, Extension.LOWERCASE);

    // 导出顺序清单
    var out = [];
    for (var j = 0; j < doc.layers.length; j++) {
        out.push(doc.layers[j].name);
    }
    var lf = new File(CONFIG.outList);
    lf.encoding = "UTF-8";
    lf.open("w");
    lf.write(out.join("\n") + "\n");
    lf.close();

    app.preferences.rulerUnits = prevUnits;

    var missCount = 0;
    for (var m = 0; m < log.length; m++) {
        if (log[m].indexOf("MISSING") === 0) { missCount++; }
    }

    // 不用 alert（COM 调用下会阻塞）：把结果写进日志文件
    var rf = new File(CONFIG.outPsd.replace(/\.psd$/i, "-build-log.txt"));
    rf.encoding = "UTF-8";
    rf.open("w");
    rf.write("layers=" + doc.layers.length + " missing=" + missCount + "\n");
    rf.write(log.join("\n") + "\n");
    rf.close();
}

main();
