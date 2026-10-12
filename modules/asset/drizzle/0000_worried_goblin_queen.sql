CREATE TABLE `assets` (
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`owner`, `id`)
);
--> statement-breakpoint
CREATE TABLE `connections` (
	`owner` text NOT NULL,
	`exchange` text NOT NULL,
	`encrypted` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner`, `exchange`)
);
--> statement-breakpoint
CREATE TABLE `sync_locks` (
	`owner` text PRIMARY KEY NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`owner` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`owner`, `key`)
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`owner` text NOT NULL,
	`date` text NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`owner`, `date`)
);
