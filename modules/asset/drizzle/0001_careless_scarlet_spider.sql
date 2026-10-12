CREATE TABLE `auth_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`attempts` integer NOT NULL
);
