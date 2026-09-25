# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

## 常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `POST /api/tourBoxes`
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`

SQLite数据库文件会在首次启动时创建到`data/app.db`。

## 偶头损耗台账（巡演连排）

入口、损耗计算、台账分三个模块实现：`wear/routes.js`（HTTP入口）、`wear/calculator.js`（纯函数损耗计算）、`wear/ledgerStore.js`（台账持久化）。

规则：

- 登记一场演出要写偶头、场次等级、分钟数、修补次数；轻场每分钟1点、常演2点、重场3点，每次修补另计1点
- 自上次保养的保养后读数起累计，累计到 **120点停用**；停用后联动偶头档案置为`不可演出`
- 保养单写明**处理人**和**前后读数**后才回台（读数重置为保养后读数，档案置回`可演出`）
- 偶头有未结束演出时再排一场，返回 **409** 且不保存新单；已停用再排场同样 409
- 改过时长、等级或修补次数后，从上次保养**重算**，旧放行失效（可当场转停用）；停用是粘住的，只能靠保养单解除

接口：

- `POST /api/wear/orders` 登记演出 `{puppetHeadId, level, minutes, repairs?}`
- `POST /api/wear/orders/:id/finish` 收场（结束演出）
- `PATCH /api/wear/orders/:id` 改 `{minutes?, level?, repairs?}`，从上次保养重算
- `GET /api/wear/orders?puppetHeadId=&status=` 查演出单
- `POST /api/wear/maintenances` 保养单 `{puppetHeadId, handler, beforeReading, afterReading, note?}`
- `GET /api/wear/maintenances?puppetHeadId=` 查保养单
- `GET /api/wear/heads/:puppetHeadId` 当前损耗快照（累计读数、放行/停用、未结束演出）
- `GET /api/wear/heads/:puppetHeadId/ledger` 台账流水（逐笔累计读数）
- `GET /api/wear` 费率与阈值说明
