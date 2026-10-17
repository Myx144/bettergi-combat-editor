# BetterGI Combat Editor

面向 BetterGI 战斗 JSON 的可视化流程与时间轴编辑器。

将角色拖入时间轴，再编排技能、普攻、等待、移动、冲刺及键鼠动作。支持角色兼容分支、框选与吸附、撤销重做、工程保存和战斗 JSON 导出；桌面与移动端共用同一套编辑逻辑。

## 直接运行

Windows 成品无需安装 Node.js、Python 或 BetterGI。

1. 下载 Windows x64 便携版，双击 `BetterGI-Combat-Editor-版本-win-x64.exe`。
2. 或解压 Windows ZIP，双击其中的 `BetterGI Combat Editor.exe`。
3. 工程可保存为 JSON；导出的战斗 JSON 交给 BetterGI 使用。

浏览器版直接打开本仓库的 `index.html` 即可，也可以放到静态网站上。

`examples/raiden-team.project.json` 是可重新编辑的示例工程，`examples/raiden-team.combat.json` 是对应的战斗脚本。

角色和技能图片通过第三方公开图片地址加载；离线时显示文字图标，编辑、保存与导出仍可使用。软件不包含网站登录、扫码、云端项目或任务控制服务。

## 从源码运行

使用 Node.js 22.12 或更高版本：

```sh
npm ci
npm start
```

检查与测试：

```sh
npm run check
npm test
```

Windows x64 打包：

```sh
npm run dist:win
```

输出位于 `release/`。初版未进行代码签名。

## 时间与执行

“按步骤推进”按动作完成记录和原生就绪条件生成执行顺序；时间轴用于预计排轴。网络延迟、命中停顿、游戏状态等可能改变实际时长，编辑器不会把计划秒数当作技能已成功释放的证明。

角色换人使用 1 秒间隔，开场无需额外等待；后台效果和冷却使用同一时间基准。释放动作和无动作站场分别显示。普攻、等待、移动等是可以独立排列的动作。

本仓库没有打包缺少明确再分发许可的第三方帧数表。未知释放时间会标为待实测；可在动作属性内设置校准值，校准会随工程保存。默认持续时间是规划估计，不能当作实测结果。

兼容角色以定位分支保存各角色的技能映射、参数和校准，导出同一份原生策略供不同阵容选择。

## 工程兼容

工程格式保留 `betterbgi-combat-timeline`、版本 1，以便重新打开已有工程。固定角色流程使用编译器版本 3，兼容角色分支使用版本 4。导出文件保留工程元数据，重新导入时恢复排轴；手工修改原生 JSON 时以实际修改内容为准。

更改工程格式或导出语义时，需要保留旧版本迁移和往返测试。测试中的校准数据是人工构造的约束输入，不是实测帧数库。

## 资料与许可

原创编辑器代码使用 MIT License。角色资料、图标库及桌面运行时各自保留原许可，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

角色资料固定来源版本记录于 `data/catalog-source.json`，通过以下命令重新生成：

```sh
npm run build:catalog
```

此项目为独立社区工具，与游戏官方无隶属关系。
