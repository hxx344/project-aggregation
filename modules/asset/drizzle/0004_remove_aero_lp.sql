-- 工作台已移除 Aero LP 模块：删除它同步进来的链上估值行与同步缓存，避免旧估值一直计入总额。
DELETE FROM `assets` WHERE json_valid(`data`) AND json_extract(`data`, '$.mode') = 'aero';--> statement-breakpoint
DELETE FROM `settings` WHERE `key` = 'aero-lp';
