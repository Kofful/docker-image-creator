CREATE TABLE `deployments` (
  `config_id` CHAR(36) NOT NULL,
  `revision_id` CHAR(36) NOT NULL,
  `operation_id` CHAR(36) NOT NULL,
  `state` ENUM('starting','running','stopping','stopped','failed','unknown') NOT NULL,
  `manifest` MEDIUMTEXT NOT NULL,
  `digest` CHAR(64) NOT NULL,
  `observed_at` DATETIME(3) NULL,
  PRIMARY KEY (`config_id`),
  CONSTRAINT `deployments_config_id_fkey` FOREIGN KEY (`config_id`) REFERENCES `configurations` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `deployments_revision_id_fkey` FOREIGN KEY (`revision_id`) REFERENCES `config_revisions` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `runtime_operations` (
  `id` CHAR(36) NOT NULL,
  `user_id` CHAR(36) NOT NULL,
  `config_id` CHAR(36) NOT NULL,
  `revision_id` CHAR(36) NOT NULL,
  `request_key` CHAR(36) NOT NULL,
  `type` ENUM('start','stop') NOT NULL,
  `status` ENUM('queued','running','succeeded','failed') NOT NULL DEFAULT 'queued',
  `stage` VARCHAR(32) NOT NULL DEFAULT 'queued',
  `error_code` VARCHAR(32) NULL,
  `cleanup_pending` BOOLEAN NOT NULL DEFAULT false,
  `lease_token` CHAR(36) NULL,
  `deadline_at` DATETIME(3) NULL,
  `lease_expires_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completed_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `runtime_operations_user_id_request_key_key` (`user_id`,`request_key`),
  INDEX `runtime_operations_status_created_at_idx` (`status`,`created_at`),
  INDEX `runtime_operations_config_id_status_idx` (`config_id`,`status`),
  CONSTRAINT `runtime_operations_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `runtime_operations_config_id_fkey` FOREIGN KEY (`config_id`) REFERENCES `configurations` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `runtime_operations_revision_id_fkey` FOREIGN KEY (`revision_id`) REFERENCES `config_revisions` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `runtime_reservations` (
  `user_id` CHAR(36) NOT NULL,
  `config_id` CHAR(36) NOT NULL,
  PRIMARY KEY (`user_id`),
  UNIQUE INDEX `runtime_reservations_config_id_key` (`config_id`),
  CONSTRAINT `runtime_reservations_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `runtime_reservations_config_id_fkey` FOREIGN KEY (`config_id`) REFERENCES `configurations` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `runtime_ports` (
  `port` INTEGER NOT NULL,
  `config_id` CHAR(36) NOT NULL,
  PRIMARY KEY (`port`),
  INDEX `runtime_ports_config_id_idx` (`config_id`),
  CONSTRAINT `runtime_ports_config_id_fkey` FOREIGN KEY (`config_id`) REFERENCES `configurations` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
