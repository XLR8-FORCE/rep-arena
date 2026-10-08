CREATE TABLE `live_rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`phase` text DEFAULT 'queued' NOT NULL,
	`ready_a` integer DEFAULT 0 NOT NULL,
	`ready_b` integer DEFAULT 0 NOT NULL,
	`seen_a` integer NOT NULL,
	`seen_b` integer,
	`updated` integer NOT NULL,
	`starts_at` integer,
	`ends_at` integer,
	`sid_a` text,
	`sid_b` text,
	`events_a` text DEFAULT '[]' NOT NULL,
	`events_b` text DEFAULT '[]' NOT NULL,
	`reps_a` integer DEFAULT 0 NOT NULL,
	`reps_b` integer DEFAULT 0 NOT NULL,
	`finished_a` integer DEFAULT 0 NOT NULL,
	`finished_b` integer DEFAULT 0 NOT NULL,
	`winner` text,
	`reason` text,
	`version` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `live_rooms_phase` ON `live_rooms` (`phase`,`updated`);
