# 第三方组件与资源声明

CodeLoop 的项目许可见 [LICENSE](LICENSE)，上游来源见 [NOTICE](NOTICE)。项目许可不替代第三方组件、字体和品牌资源各自的许可，也不授予第三方商标使用权。

## 随仓库提供的资源

| 资源 | 来源与许可 | 随附声明 |
| --- | --- | --- |
| Inter Variable 字体 `web/public/InterVariable.woff2` | [Inter](https://github.com/rsms/inter)，SIL Open Font License 1.1；Copyright (c) 2016 The Inter Project Authors | [Inter-LICENSE.txt](web/public/Inter-LICENSE.txt)，保留原文 |
| `@lobehub/icons-static-svg` 1.94.0 中使用的 SVG 图标 | [LobeHub Icons](https://github.com/lobehub/lobe-icons/tree/v1.94.0)，MIT；Copyright (c) 2023 LobeHub | [LobeHub MIT 正文](web/public/licenses/lobe-icons-MIT.txt)，复制自该版本的 LICENSE；位于 public 目录，构建时随静态资源复制 |

`web/public/codex-agent-logo.png`、`web/public/codex-app-icon.png` 和 `web/src/assets/x-logo-black.png` 为品牌图像。当前仓库未记录这些文件的原始下载地址及单独授权凭据，不能据本项目的 Apache-2.0 声明推定其获得了额外授权。它们的来源核实仍未完成；对外制作安装包或宣传材料时，应先核实相应使用条件，无法确认时使用自有资源替换。

## npm 依赖

依赖版本和包内许可元数据记录在 [package-lock.json](package-lock.json)，直接依赖见 [package.json](package.json)。上表用于说明字体、图标等资源，不是全部直接和间接依赖的许可证清单。依赖的版权与许可声明应按其随包 LICENSE、NOTICE 等文件保留，升级依赖时重新核对。

## 分发范围

分发本仓库源码时，携带根目录的 `LICENSE`、`NOTICE`、本文件以及各资源随附的许可正文。只分发构建产物或安装包时，也需将适用的项目和依赖许可证、归属声明随包提供；仅运行 Vite 构建不会自动收集所有 npm 依赖许可证，也不会复制根目录的声明文件。
