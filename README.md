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

## 巡演连排损耗

排演损耗按场次等级计点：轻场每分钟 1 点，常演 2 点，重场 3 点；累计到 120 点偶头停用，
保养单写明处理人和前后读数后才回台，累计点数从上次保养起算。

- `POST /api/rehearsals` 登记排演新单：`{ puppetHeadId, level, minutes, repairCount }`，
  level 取 `轻场/常演/重场`。偶头有未结束演出或已停用时返回 409，且不保存新单。
- `POST /api/rehearsals/:id/finish` 结束一场演出。
- `PATCH /api/rehearsals/:id` 改时长、等级或修补次数后，从上次保养重算，旧放行失效。
- `POST /api/maintenance` 登记保养单：`{ puppetHeadId, handler, readingBefore, readingAfter }`，
  缺处理人或前后读数返回 400，登记后偶头回台、点数归零起算。
- `GET /api/rehearsals/ledger/:puppetHeadId` 查看偶头损耗台账（场次明细、累计点数、是否停用）。

实现分三层：入口 `rehearsalRoutes.js`、损耗计算 `wear.js`、台账 `ledger.js`，存储走 `db.js`。

SQLite数据库文件会在首次启动时创建到`data/app.db`。
