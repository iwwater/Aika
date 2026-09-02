/**
 * 占位立绘。
 *
 * 按 tools/live2d-pipeline/character-brief.json 已锁定的视觉方向绘制：
 * 未来赛博朋克 / 全息生命、青蓝到薰衣草紫的渐变长发、圆框眼镜、蓝青渐变瞳、
 * 黑白冷调赛博服装、克制的全息扫描层。
 *
 * 这是矢量占位，不是美术定稿，也不是 Live2D 模型。M4 导入正式模型后整块删除。
 * 面部皮肤区域被扫描层的 mask 排除，遵守 brief 里「面部不叠加全息光点或粒子」的红线。
 */
const HAIR =
  "M100 14 C58 14 40 48 40 96 C40 152 32 196 24 232 C40 224 52 226 62 232 C70 214 72 176 70 140 L130 140 C128 176 130 214 138 232 C148 226 160 224 176 232 C168 196 160 152 160 96 C160 48 142 14 100 14 Z";
const OUTFIT = "M18 260 C24 216 58 192 100 192 C142 192 176 216 182 260 Z";
const RIM_LEFT = "M100 14 C58 14 40 48 40 96 C40 152 32 196 24 232";
const RIM_RIGHT = "M100 14 C142 14 160 48 160 96 C160 152 168 196 176 232";

export function AvatarPlaceholder() {
  return (
    <svg
      className="avatar-art"
      viewBox="0 0 200 260"
      role="img"
      aria-label="愛花的占位立绘，正式 Live2D 模型尚未导入"
    >
      <defs>
        <linearGradient id="aika-hair" x1="0" y1="0" x2="0.15" y2="1">
          <stop offset="0%" stopColor="#6ceeff" />
          <stop offset="40%" stopColor="#37b6ff" />
          <stop offset="74%" stopColor="#7a6cf2" />
          <stop offset="100%" stopColor="#a86bff" />
        </linearGradient>
        <linearGradient id="aika-hair-front" x1="0" y1="0" x2="0.2" y2="1">
          <stop offset="0%" stopColor="#8af4ff" />
          <stop offset="60%" stopColor="#45c0ff" />
          <stop offset="100%" stopColor="#6f7cf5" />
        </linearGradient>
        <linearGradient id="aika-skin" x1="0.2" y1="0" x2="0.6" y2="1">
          <stop offset="0%" stopColor="#eef5fd" />
          <stop offset="100%" stopColor="#c8dcef" />
        </linearGradient>
        <linearGradient id="aika-outfit" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#0e1626" />
          <stop offset="55%" stopColor="#080d18" />
          <stop offset="100%" stopColor="#191033" />
        </linearGradient>
        <radialGradient id="aika-iris" cx="0.5" cy="0.32" r="0.75">
          <stop offset="0%" stopColor="#d3f8ff" />
          <stop offset="48%" stopColor="#35d8ff" />
          <stop offset="100%" stopColor="#2b62e8" />
        </radialGradient>
        <pattern id="aika-scan" width="4" height="4" patternUnits="userSpaceOnUse">
          <rect width="4" height="1.4" fill="#7ef0ff" opacity="0.11" />
        </pattern>
        {/* 扫描层只贴合人物轮廓，并排除面部皮肤：brief 明确禁止在脸上叠加全息光点 */}
        <mask id="aika-scan-mask">
          <path d={HAIR} fill="#fff" />
          <path d={OUTFIT} fill="#fff" />
          <ellipse cx="100" cy="112" rx="33" ry="39" fill="#000" />
        </mask>
      </defs>

      {/* 后发 */}
      <path d={HAIR} fill="url(#aika-hair)" />
      {/* 服装：黑白冷调赛博，青色描边作为全息接缝 */}
      {/* 颈 */}
      <path d="M93 142 L107 142 L107 198 L93 198 Z" fill="#a8c2db" />

      {/* 服装：黑白冷调赛博，青紫描边作为全息接缝 */}
      <path d={OUTFIT} fill="url(#aika-outfit)" />
      <path d="M80 196 C86 212 114 212 120 196 C112 193 88 193 80 196 Z" fill="#e6f1fb" opacity=".88" />
      <path d="M80 196 C86 212 114 212 120 196" fill="none" stroke="#37e6ff" strokeWidth="1.4" opacity=".8" />
      <path d="M100 210 L100 260" stroke="#37e6ff" strokeWidth="1.3" opacity=".4" />
      <path d="M50 224 C62 212 76 206 90 205 M150 224 C138 212 124 206 110 205" fill="none" stroke="#9a6bff" strokeWidth="1.3" opacity=".55" />
      <path d="M38 250 L68 250 M132 250 L162 250" stroke="#e8f4ff" strokeWidth="1" opacity=".18" />

      {/* 脸 */}
      <ellipse cx="100" cy="112" rx="32" ry="38" fill="url(#aika-skin)" />

      {/* 前发与侧发 */}
      <path
        d="M66 100 C62 62 78 40 100 40 C122 40 138 62 134 100 C130 84 124 76 114 82 C110 92 104 96 96 94 C86 92 76 88 66 100 Z"
        fill="url(#aika-hair-front)"
      />
      <path d="M60 62 C50 92 50 130 54 160 C60 134 60 104 66 82 Z" fill="url(#aika-hair-front)" opacity=".92" />
      <path d="M140 62 C150 92 150 130 146 160 C140 134 140 104 134 82 Z" fill="url(#aika-hair-front)" opacity=".92" />

      {/* 眉与眼 */}
      <path d="M78 100 C82 97 89 97 93 100" stroke="#5e7ea6" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      <path d="M107 100 C111 97 118 97 122 100" stroke="#5e7ea6" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      <ellipse cx="87" cy="113" rx="6" ry="7.5" fill="url(#aika-iris)" />
      <ellipse cx="113" cy="113" rx="6" ry="7.5" fill="url(#aika-iris)" />
      <circle cx="85.4" cy="110.5" r="1.7" fill="#f2fdff" opacity=".9" />
      <circle cx="111.4" cy="110.5" r="1.7" fill="#f2fdff" opacity=".9" />
      <path d="M96 129 C98 131 102 131 104 129" stroke="#7e9ab8" strokeWidth="1.4" fill="none" strokeLinecap="round" />

      {/* 圆框眼镜，brief 里已确认保留 */}
      <g fill="none" stroke="#5fe8ff" strokeWidth="1.7" opacity=".85">
        <circle cx="87" cy="113" r="11" />
        <circle cx="113" cy="113" r="11" />
        <path d="M98 113 L102 113" />
        <path d="M76 111 L69 108 M124 111 L131 108" />
      </g>

      {/* 全息扫描层与轮廓光 */}
      <rect width="200" height="260" fill="url(#aika-scan)" mask="url(#aika-scan-mask)" />
      <path d={RIM_LEFT} fill="none" stroke="#8ff4ff" strokeWidth="1.6" opacity=".6" />
      <path d={RIM_RIGHT} fill="none" stroke="#b18cff" strokeWidth="1.4" opacity=".45" />
    </svg>
  );
}
