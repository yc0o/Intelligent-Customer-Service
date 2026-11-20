'use strict';

/**
 * 重置演示数据库：删除 data/app.db 后下次启动会重新写入种子数据。
 * 用法：npm run reset
 */

const fs = require('node:fs');
const path = require('node:path');

const base = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
let removed = 0;
for (const f of [base, `${base}-wal`, `${base}-shm`]) {
  if (fs.existsSync(f)) {
    fs.unlinkSync(f);
    removed += 1;
    console.log(`已删除 ${f}`);
  }
}
console.log(removed ? '数据库已重置，重新启动服务即可生成演示数据。' : '没有找到数据库文件，无需重置。');
