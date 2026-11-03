# Kodo 品牌资产

依据本目录原始品牌展示图重绘。`kodo-mark.svg` 和 `kodo-wordmark.svg` 是可编辑的矢量源文件；字标由路径构成，使用时不依赖字体。曲线与字标是对展示图的重绘，不是原设计软件源文件。

`kodo-brand-assets.zip` 包含以下网站与应用资产、源 SVG、预览和说明，便于复制到其它项目。

品牌名：Kodo。品牌语：**Know · Organize · Do**。中文表达：**理解目标，组织协作，执行交付。**

| 颜色 | 色值 | 用途 |
| --- | --- | --- |
| Ink | `#0B0E12` | 深色背景、浅色背景上的标识 |
| Graphite | `#687280` | 次要信息 |
| Snow | `#EAECEF` | 浅色背景、深色背景上的标识 |

## 直接使用

| 场景 | 文件 |
| --- | --- |
| 网站浅色背景 | `kodo-logo-dark.svg` |
| 网站深色背景 | `kodo-logo-light.svg` |
| 随前景色变化的内联 SVG | `kodo-logo.svg`、`kodo-mark.svg` |
| 透明背景横版 PNG | `png/kodo-logo-dark.png`、`png/kodo-logo-light.png`（2048×512） |
| 透明背景独立标识 | `png/kodo-mark-dark.png`、`png/kodo-mark-light.png`（1024×1024） |
| 应用图标源文件 | `icons/kodo-app.svg` |
| 应用商店／大图标 | `icons/kodo-app-1024.png`（不透明正方形） |
| Windows | `icons/favicon.ico`（16／32／48／64／128／256） |
| macOS | `icons/kodo-app.icns` |
| iOS／网页主屏幕 | `icons/kodo-app-180.png` |
| Android／PWA | `icons/kodo-app-192.png`、`icons/kodo-app-512.png`、`icons/site.webmanifest` |
| 小尺寸图标 | `icons/kodo-app-{16,32,48,64,128,256}.png` |
| 总览 | `preview.png` |

应用图标保留不透明方形背景，由目标系统按平台规则裁切圆角；PWA 图标的标识位于 maskable 安全区内。16／32 像素时使用独立标识，避免横版字标过小。各平台最终打包时仍需按项目的资源目录配置图标。

独立标识四周至少保留标识宽度的 1/4 作为空间。横版 SVG 已含内部留白。等比例缩放，使用单色版本；金属、光影和纹理仅用于品牌展示，不作为小尺寸标识的一部分。

## 网站接入示例

将所需文件复制到网站的 `public/brand/`：

```html
<link rel="icon" href="/brand/icons/favicon.ico" sizes="any">
<link rel="icon" href="/brand/icons/kodo-app.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/brand/icons/kodo-app-180.png">
<link rel="manifest" href="/brand/icons/site.webmanifest">

<!-- 在深色背景上使用浅色标识 -->
<img src="/brand/kodo-logo-light.svg" alt="Kodo" width="192" height="48">
```

作为 `<img>` 使用时选择明确的深／浅版本。只有内联 SVG 的 `currentColor` 会继承父元素文字颜色；独立 SVG 图片不会继承页面的 `color`。

## TUI

`src/tui/brand.ts` 中的点阵标识由同一个 `kodo-mark.svg` 生成，提供 32×14 和 16×7 两种尺寸，保留曲线之间的留白。首页居中显示标识，顶部仅显示名称／版本和工作区，底部保留有完整边框的多行输入框与一行 Ask／YOLO 模式及状态；品牌语和使用说明通过命令查看。界面文案使用英文，用户输入、文件及模型回复保留原文。窄屏／矮屏自动简化；文字采用默认终端前景色以适应深浅主题，并支持 `NO_COLOR` 与 `TERM=dumb`。

## 重新导出

修改两个 SVG 源文件后运行：

```powershell
python -m pip install Pillow CairoSVG
python 'scripts/build-brand-assets.py'
```

导出脚本更新网站／应用资产、预览和 TUI 字符标识；无需在 Kodo 运行环境中安装这些 Python 依赖。
