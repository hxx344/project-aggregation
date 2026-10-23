CREATE TABLE `fill_cache` (
	`owner` text NOT NULL,
	`account` text NOT NULL,
	`scope` text NOT NULL,
	`revision` text NOT NULL,
	`data` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`owner`, `account`, `scope`)
);
