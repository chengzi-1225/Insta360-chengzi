# Insta360-chengzi
橙子自制/自用脚本
涉及多个场景整合

<!-- id-switching:start -->
## ID 切换 v3.19.1

[安装 / 更新](https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/insta360-IDswitching.user.js) · [使用说明](docs/id-switching.md) · [常显与框选演示（下载后打开）](docs/demos/insta360-always-visible.html) · [视频演示（下载后打开）](docs/demos/insta360-id-switch.html) · [TXT 备份](docs/downloads/insta360-IDswitching-3.19.1.txt)

新增 **常显设置**：可多选比例、具体 ID，并添加“主体”“杂物”等文本标签。文本支持“完整标签”与“包含文字”匹配，比例和文本刷新后保留；具体 ID 只用于当前任务。

三类列表均支持鼠标拖动框选。从未勾选项开始批量勾选，从已勾选项开始批量取消；Alt 拖动强制取消，Esc 取消本次拖动。保留人物-1、人物-2默认常显、当前框显示和搜索后批量选择。

保留空格播放暂停视频、A / D 导航、S 循环比例、独立的数值与任务更新快捷键、标签同步开关（默认关闭）和原生删框撤回。已通过语法及 Chrome 浏览器检查；演示内嵌当前脚本，使用本地示例。实际业务页面尚未登录验证。
<!-- id-switching:end -->

## 审核与评论帧工具箱 1.0.8

截图范围可直接选择 **左侧｜全部｜右侧**，自动记住上次的选择；一键截图和图片编辑使用相同范围。

自动识别同一编辑器中紧邻原图的右侧原生图片，并一起保留底图、标注框、网格和参考线。正常识别后无需手动补选；没有识别到右侧时才显示“选择右侧”。保留普通裁切和全景预览截图。

更新脚本后刷新标注页面即可使用。本地原生双图、普通裁切和全景预览已验证；实际项目页面请更新后确认效果。

<!-- reset-annotations:start -->
## 清空标注并恢复待标注 v1.0.5

[安装 / 更新最新版](https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/label-studio-reset-annotations.user.js) · [使用说明](docs/reset-annotations.md)

勾选任务或输入 ID 后直接清理，无需等待整批预览。预览与下载备份可选；未下载备份时执行弹确认，已下载则不重复弹窗。

接入平台实际提供的 Delete Reviews and Scores、Delete Acceptances、Delete Reviewers 和 Delete Annotators，先执行原生关联清理，再删除标注、草稿及预标注，保留任务和视频。人员清理仅在账号提供对应动作时执行；不会自动提交批量状态转换。

支持跨页6000条完整读取，直接模式每100个任务调用平台批量清理，读取与核查最多8个任务并行。新增独立标注列表回查和“核查是否清空”，接口成功但仍有内容不会显示完成。平台不提供批量动作时保留逐条处理。

停止不会恢复已删内容，已发出的整批请求仍可能完成；不再启动后续批次。后台内容删除只读核查完成后继续，无法确认的操作显示待核实，不重复提交。

62项本地模拟测试通过，包含205个任务9次批量写入、三个任务全部清空、详情漏报、接口假成功、后台任务和停止核查。真实账号的问题仍需独立核查；固定安装和自动更新链接保持不变。
<!-- reset-annotations:end -->


<!-- regions-direct:start -->
## Regions 直接清空并提交 v3.2.5

[安装 / 更新](https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/label-studio-regions-clear-submit.user.js) · [使用说明](docs/regions-clear-submit.md)

基于用户提供的 Regions v3.2.0 修改，删除预览、快照核对和预览后二次勾选。输入 ID 或导入页面勾选 / 全选，点击“直接清空并提交”，确认一次后逐条打开任务、清空轨迹、原生提交并回读验证。

沿用原脚本范围：清空默认标注中的 reframe 轨迹及关联关系，保留视频级分类。提交后状态为已提交。无轨迹任务跳过；失败停止后续任务，提交不会自动重试。最多10000个任务；停止时完成当前任务，再停止后续任务。

v3.2.5 将下一任务的只读预取提前到当前编辑器加载期间；完整结果比较不再排序并复制每帧字段后生成完整字符串；连续进度合并刷新，减少大批量表格开销。保留清空前1.5秒、提交后150ms稳定窗口、服务器回读与完整结果校验。沿用 Ctrl+Enter 提交和空轨迹跳过。

42项本地模拟测试通过。本机20000帧结果比较中位耗时约62.2ms降至24.7ms，只衡量本地比较开销。本修改版尚未在真实项目执行，整体速度取决于平台和视频响应。固定安装和自动更新地址已加入脚本头。
<!-- regions-direct:end -->


<!-- personal-workbench:start -->
## 我的工作台 v1.8.3

[安装 / 更新](https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/Insta360我的工作台.user.js) · [使用说明](docs/personal-workbench.md) · [测试页面（下载后双击打开）](docs/demos/insta360-workbench.html) · [完整下载包](docs/downloads/Insta360我的工作台-1.8.3.zip)

工作区与项目统一使用可搜索的白色菜单，长列表限高并在内部滚动，避免原生菜单占满屏幕。增大筛选与表格字号、提高文字对比度，收紧空白；保留四项核心指标和项目对比表格。筛选修改显示简短提示，查询中展示占位行。

返修 / 返工每批读取 10 个项目，最多两个并发，临时失败自动重试一次；部分失败保留结果，可单独重试待处理。搜索目录和本地结果不重复查询产量。

5 项数据逻辑、15 组浏览器交互、5 组超时恢复、筛选交互、精简布局及标注 / 审核路由检查通过。新增 70 个工作区的限高菜单、搜索、键盘、失败重试和加载状态验证，覆盖 320–1920px。测试页使用模拟数据；真实平台效果需更新脚本并刷新后确认。固定安装与自动更新地址保持不变。
<!-- personal-workbench:end -->

<!-- review-crop-guard:start -->
## 审核裁剪框修改保护 v1.1.0

[安装 / 更新](https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/ls-review-crop-guard.user.js) · [使用说明](docs/ls-review-crop-guard.md)

保护 `label.insta360.com` 下所有项目的审核中心。阻止裁剪预览初始化清空未提交的修改历史，保留撤销、重做、待执行的自动保存和平台原有审核提交逻辑。左下角显示保护状态，保留动态预览及模板比例锁定。

安装后刷新审核页，确认“审核修改保护：已启用”，再移动框并切换比例。已经丢失的修改历史无法由脚本恢复。

11 项本地复现测试通过，并已确认线上中间件拦截接口可用；尚未完成真实审核提交后重新打开的完整验收。
<!-- review-crop-guard:end -->
## Label Studio 数据工具

项目 ID、项目进度与周报、历史通过率和全部评论已整合到顶部“统计数据”入口，点击后在项目列表上方展开，随页面滚动，不使用悬浮窗口或右侧浮动入口。左侧共用项目清单，右侧切换功能；支持搜索、累计跨页项目、粘贴 ID 或链接及导出已读数据 Excel。

- [项目统计数据合并版 2.0.1（推荐安装 / 更新）](https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/project-stats/copy-project-ids.user.js)：沿用原“项目 ID 一键复制”脚本，可覆盖升级并保留累计项目与周报快照。历史通过率按每次通过和驳回计数、支持日期筛选；全部时间评论按项目和标注员合并，不同项目分表。
- [原通过率脚本兼容更新 1.5.1](./Insta360_框ID通过率统计.user.js)：相同合并功能，两份任选一个。使用推荐合并版时，停用另一份通过率和旧独立评论脚本。
- [旧版独立评论导出](./Insta360_全部评论导出.user.js)：保留兼容，日常使用合并版即可。

安装和使用方法见 [Label Studio 油猴脚本说明](./docs/label-studio-oil-scripts.md)。

