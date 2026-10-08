CREATE TABLE `activity` (
	`user` text NOT NULL,
	`exercise` text NOT NULL,
	`day` text NOT NULL,
	PRIMARY KEY(`user`, `exercise`, `day`),
	FOREIGN KEY (`user`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `friends` (
	`id` text PRIMARY KEY NOT NULL,
	`requester` text NOT NULL,
	`recipient` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created` integer NOT NULL,
	FOREIGN KEY (`requester`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `friends_recipient` ON `friends` (`recipient`);--> statement-breakpoint
CREATE INDEX `friends_requester` ON `friends` (`requester`);--> statement-breakpoint
CREATE TABLE `ladders` (
	`user` text NOT NULL,
	`exercise` text NOT NULL,
	`rating` integer DEFAULT 600 NOT NULL,
	`wins` integer DEFAULT 0 NOT NULL,
	`losses` integer DEFAULT 0 NOT NULL,
	`draws` integer DEFAULT 0 NOT NULL,
	`best` integer DEFAULT 0 NOT NULL,
	`shields` integer DEFAULT 0 NOT NULL,
	`earned` integer DEFAULT 0 NOT NULL,
	`shield_week` text DEFAULT '' NOT NULL,
	`shield_day` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`user`, `exercise`),
	FOREIGN KEY (`user`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `matches` (
	`id` text PRIMARY KEY NOT NULL,
	`exercise` text NOT NULL,
	`a` text NOT NULL,
	`b` text,
	`status` text NOT NULL,
	`ra` integer NOT NULL,
	`rb` integer,
	`score_a` integer,
	`score_b` integer,
	`delta_a` integer,
	`delta_b` integer,
	`saved_a` integer DEFAULT 0 NOT NULL,
	`saved_b` integer DEFAULT 0 NOT NULL,
	`created` integer NOT NULL,
	`expires` integer NOT NULL,
	`completed` integer,
	FOREIGN KEY (`a`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`b`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `matches_a` ON `matches` (`a`,`created`);--> statement-breakpoint
CREATE INDEX `matches_b` ON `matches` (`b`,`created`);--> statement-breakpoint
CREATE INDEX `matches_queue` ON `matches` (`status`,`exercise`,`created`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user` text NOT NULL,
	`exercise` text NOT NULL,
	`match` text,
	`started` integer NOT NULL,
	`finished` integer,
	`reps` integer,
	`status` text NOT NULL,
	`evidence` text,
	FOREIGN KEY (`user`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`match`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_user` ON `sessions` (`user`,`started`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_match_user` ON `sessions` (`match`,`user`);--> statement-breakpoint
CREATE TABLE `slots` (
	`user` text NOT NULL,
	`exercise` text NOT NULL,
	`match` text NOT NULL,
	PRIMARY KEY(`user`, `exercise`),
	FOREIGN KEY (`user`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`match`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`handle` text NOT NULL,
	`name` text NOT NULL,
	`created` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_handle_unique` ON `users` (`handle`);
