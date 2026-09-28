# ClipFlow Analytics

独立的 App Store Connect Analytics 脚本项目。Node.js 22+，无需安装依赖。所有命令在本目录运行。

## 本机配置

当前机器已配置 `.env` 和 `.secrets/` 下的 P8。迁移到另一台机器时，复制 `.env.example` 为 `.env`，填写 Issuer ID、Key ID、数字 App ID 与私钥路径。相对私钥路径以项目目录为基准；环境变量优先于 `.env`。

`.env`、`.secrets/`、`data/` 和 `output/` 均被 Git 忽略。不要提交私钥、JWT、下载签名链接或业务报表。Admin Key 用于初始化；日常读取可换为 Sales and Reports Key，并同时更换 Key ID 与私钥路径。

## 常用命令

```sh
npm run status       # 验证鉴权、显示 App 和报表请求状态
npm run setup        # 开启 ONGOING；已有有效请求则复用
npm run reports      # 列出 Apple 实际提供的报表名称和 ID
npm run sync         # 下载所有可用报表的 DAILY 实例
npm run analyze      # 生成本地文件清单、列名、行数和事件日期范围
npm test             # 无网络测试
```

首次 setup 后，报表通常需要 24–48 小时生成。没有报表时 sync 会正常提示等待，不代表业务指标为零。之后可以手动重复 sync 和 analyze。2026-09-17 已在 Codex 当前任务中启用“ClipFlow 每日数据分析”，每天北京时间 08:30 拉取并分析，日报保存在 `output/daily/YYYY-MM-DD.md`。该调度由 Codex 管理，本项目没有安装系统 cron；执行时需要本机项目与凭据可用、电脑开启且桌面应用运行。

需要历史数据时可手动执行 `npm run snapshot`。它会申请 ONE_TIME_SNAPSHOT；已经存在未停用的同类请求则复用，不自动反复申请历史快照。snapshot 和 ongoing 的文件分别保存。

只下载某一个报表时，使用 reports 返回的完整名称：

```sh
npm run sync -- "App Store Downloads Standard"
```

这个名称只是示例，以 Apple 返回的实际名称为准。

## 文件和分析

- `data/reports.json`：报表目录。
- `data/raw/<request>/<report>/<instance>/`：原始 gzip 与解压后的 TSV。
- `data/manifest.json`：已完整下载的实例及各分片本地 SHA-256。
- `output/summary.md` / `summary.json`：本地数据概览。

脚本遍历分页并下载全部分片；仅在一个实例的所有分片下载、解压和格式验证成功后记录完成。重跑跳过已完成实例，未完成实例会重新下载；文件以临时文件加重命名写入。运行期间使用 `data/.lock` 避免多个进程冲突。崩溃遗留锁时，确认记录的 PID 已停止后再删除锁文件。

可对一个 TSV 文件的明确数值列做分组汇总：

```sh
npm run analyze -- data/raw/实际路径/分片.tsv Counts Date Territory
```

结果写入 `output/aggregation.json`。列名以 summary.json 为准。此命令仅汇总指定文件，不能代表整个 App 的完整数据；同一个实例若有多个分片，需要按报表语义进一步合并。缺失或隐私抑制的非数值会报错，不会当作零。

不要直接合并 Standard/Detailed、不同粒度或 ONGOING/SNAPSHOT。`processingDate` 是处理日，事件日看文件的 `Date`。报表可能含迟到事件和修正批次，唯一用户、设备数及平均值不能简单求和。本版提供原始数据和基础探查，不自动生成跨批次 KPI、留存率或转化率；进一步分析前必须核对该报表的批次和修正规则。

## 排错

- 401：检查 Key ID、Issuer ID、P8 是否配套，以及系统时间。
- 403：检查角色和 API 访问权限；setup 需要 Admin。
- 429 / 5xx：读取请求有限退避重试。POST 不自动重试；异常后先 status，再 setup，避免重复申请。
- 下载链接过期或网络中断：重跑 sync，重新获取签名链接。Apple JWT 仅发送到官方 API，不发送到文件下载地址。
- `stoppedDueToInactivity`：执行 setup 申请新的持续请求。

## 验证与影响范围

测试覆盖 JWT 签名、TSV 解析、事件日期和汇总的缺失值处理；模拟 API 集成测试覆盖分页、多分片中断后重试、完成后跳过和下载请求不携带 JWT。实际鉴权和报表初始化需以本机命令结果为准；尚未生成报表时不能视为真实下载链路已验证。

这是仓库根目录下的独立运维工具，没有 iOS App、共享工作区、路由或服务端运行代码的消费者。不改变 App 功能、权限、数据采集或第三方 SDK；无需改动 App Intents、分享入口、继续处理、产品介绍、翻译、网站、隐私政策和 App Store 元数据。无需设备或模拟器回归。

官方文档：
- [报表概览](https://developer.apple.com/help/app-store-connect-analytics/overview/analytics-reports-api)
- [JWT 鉴权](https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests)
- [申请报表](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-analyticsreportrequests)
- [下载流程](https://developer.apple.com/documentation/appstoreconnectapi/downloading-analytics-reports)
