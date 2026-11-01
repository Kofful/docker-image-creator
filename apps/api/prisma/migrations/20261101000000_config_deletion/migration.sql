ALTER TABLE `configurations`
  ADD COLUMN `deleted_at` DATETIME(3) NULL,
  ADD COLUMN `cleanup_pending` BOOLEAN NOT NULL DEFAULT false,
  ADD INDEX `configurations_user_id_deleted_at_created_at_idx` (`user_id`, `deleted_at`, `created_at`),
  ADD INDEX `configurations_cleanup_pending_deleted_at_idx` (`cleanup_pending`, `deleted_at`),
  DROP INDEX `configurations_user_id_created_at_idx`;
