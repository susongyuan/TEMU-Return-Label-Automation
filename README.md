# 退货面单自动化

独立模块，和 `前后端价格显示及预警功能` 分开。当前主链路为 API 模式：易仓、谷仓、万邑通都优先使用开放接口；旧网页登录自动化模块保留为后续兜底。

主看板只通过外链跳转到本服务，不直接引用本目录代码。历史记录写入同一个 MySQL 数据库的 `return_label_history` 表，方便和运营看板共用留痕。

## 运行

```powershell
cd "C:\Users\Administrator\Desktop\project\6\return-label-automation"
npm install
npm start
```

打开 `http://127.0.0.1:3206`。

Docker:

```powershell
docker build -t temu-return-label-automation .
docker run -d --name temu-return-label -p 3206:3206 --env-file .env temu-return-label-automation
```

## 数据库

`.env` 里配置共享 MySQL：

```env
RETURN_DB_HOST=127.0.0.1
RETURN_DB_PORT=3306
RETURN_DB_USER=temu_app
RETURN_DB_PASSWORD=
RETURN_DB_NAME=temu_monitor
```

也兼容主看板使用的 `DB_HOST`、`DB_USER`、`DB_PASSWORD`、`DB_NAME`。

## 安全开关

- 默认 `DRY_RUN_DEFAULT=true`，只预检和填表，不点保存/提交。
- 真实创建必须前端取消“预检模式”并勾选“允许真实创建”。
- `REAL_CREATE_MAX_PER_JOB=1` 限制每批最多真实创建 1 单；需要小批量谷仓草稿提交时先调高这个值。
- `API_MODE=api` 为默认主链路。
- `.env` 保存本机账号配置，已被根目录 `.gitignore` 排除。

## 流程

1. 输入原始订单号，程序自动去掉末尾拆单后缀如 `-D01`，再补 `ST-`。
   - 每行只填订单号：走平台自动物流。谷仓会从官方退货物流里按费用计算机匹配最低价，且排除 `UK_DHL_LOC_RETURN`。
   - 每行填 `订单号 退货物流号 物流商`：走自选物流。谷仓创建时使用自选物流并写入退货物流号；万邑通保持 `Return Label=否`，把物流号和物流商传给退货单。
2. 用易仓 OpenAPI 匹配订单，读取跟踪号、仓库线索、仓库 SKU 和地址。
3. 如果易仓不能明确仓库，统一使用易仓返回的跟踪号分别去谷仓/万邑通 API 查询仓库订单。
4. 到对应仓库平台调用 OpenAPI 获取仓库订单、包裹、地址和产品信息。
5. 谷仓和万邑通都会先调用各自 API 试算或查询 Return Label 可用物流，选择可报价的最低价官方物流。
6. 如果试算失败、必填资料缺失，或接口鉴权失败，会返回需复核，不继续真实创建。
7. dry-run 输出预检结果；真实创建成功后返回退货单号、跟踪号/面单号，并保存 Base64 面单文件供前端下载。

## 已验证样例

- 万邑通：`PO-012-01478546750070498` -> `RT16000304886887CN`，Return Label 跟踪号 `33FJV484277701000655006`。
- 谷仓：`G1915-260616-0607` 测试草稿批量提交后生成 `RG1915-260616-0027`，跟踪号 `510038370771`，物流产品 `DE_DHL_RETURN_INT`。

当前实现是 API 优先的可扩展骨架。三平台 API client 在 `src/api/*.js`。

## API

- `POST /api/jobs`：提交 `input` 或 `orders`，可带 `dryRun`、`allowCreate`、`preferCrawlerOnly`
- `POST /api/preflight-jobs`：预检任务别名，等价于 `dryRun=true`、`allowCreate=false`
- `GET /api/jobs/:id`：查询任务结果
- `GET /api/jobs/:id/events`：SSE 推送进度
- `GET /api/history`：从 MySQL 读取退货面单历史
- `GET /api/return-label/history`：同上，方便被其它系统按模块接口调用

主看板通过 `/api/return-label/open` 跳转到本服务，并可携带 `authToken`、`operatorKey`、`operatorName`，用于把操作人留痕带过来。

结果里会带 `displayStatus`、`statusLabel`、`shippingQuote`、`selectedLogistics`、`logisticsCandidates`，方便批量查看试算和创建状态。

## 并发预检

```powershell
npm run test:preflight -- --count=10 --concurrency=10
```

`count` 最大建议 20。该脚本只走预检，不会真实创建退货单。
