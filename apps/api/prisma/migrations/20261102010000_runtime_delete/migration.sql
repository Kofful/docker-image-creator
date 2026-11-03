ALTER TABLE `configurations` ADD COLUMN `deletion_requested_at` DATETIME(3) NULL;
ALTER TABLE `runtime_operations` MODIFY COLUMN `type` ENUM('start', 'stop', 'delete') NOT NULL;
