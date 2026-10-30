CREATE TABLE `configurations` (
  `id` CHAR(36) NOT NULL,
  `user_id` CHAR(36) NOT NULL,
  `name` VARCHAR(80) NOT NULL,
  `description` VARCHAR(500) NOT NULL,
  `services` JSON NOT NULL,
  `request_key` CHAR(36) NOT NULL,
  `input_digest` CHAR(64) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `configurations_user_id_created_at_idx` (`user_id`, `created_at`),
  UNIQUE INDEX `configurations_user_id_request_key_key` (`user_id`, `request_key`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `generation_attempts` (
  `id` CHAR(36) NOT NULL,
  `config_id` CHAR(36) NOT NULL,
  `status` ENUM('queued', 'running', 'succeeded', 'failed') NOT NULL DEFAULT 'queued',
  `stage` VARCHAR(32) NOT NULL DEFAULT 'queued',
  `input_encrypted` MEDIUMTEXT NOT NULL,
  `output_encrypted` MEDIUMTEXT NULL,
  `output_truncated` BOOLEAN NOT NULL DEFAULT false,
  `cleanup_pending` BOOLEAN NOT NULL DEFAULT false,
  `error_code` VARCHAR(32) NULL,
  `lease_token` CHAR(36) NULL,
  `deadline_at` DATETIME(3) NULL,
  `lease_expires_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completed_at` DATETIME(3) NULL,
  INDEX `generation_attempts_status_created_at_idx` (`status`, `created_at`),
  INDEX `generation_attempts_status_lease_expires_at_idx` (`status`, `lease_expires_at`),
  INDEX `generation_attempts_config_id_idx` (`config_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `config_revisions` (
  `id` CHAR(36) NOT NULL,
  `config_id` CHAR(36) NOT NULL,
  `generation_id` CHAR(36) NOT NULL,
  `version` INTEGER NOT NULL,
  `spec` JSON NOT NULL,
  `compose` MEDIUMTEXT NOT NULL,
  `digest` CHAR(64) NOT NULL,
  `artifact_path` VARCHAR(255) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `config_revisions_generation_id_key` (`generation_id`),
  UNIQUE INDEX `config_revisions_config_id_version_key` (`config_id`, `version`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `config_secrets` (
  `id` CHAR(36) NOT NULL,
  `config_id` CHAR(36) NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `value_encrypted` TEXT NOT NULL,
  UNIQUE INDEX `config_secrets_config_id_name_key` (`config_id`, `name`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `generation_slots` (
  `id` INTEGER NOT NULL,
  `generation_id` CHAR(36) NULL,
  `lease_token` CHAR(36) NULL,
  `lease_expires_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `configurations` ADD CONSTRAINT `configurations_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `generation_attempts` ADD CONSTRAINT `generation_attempts_config_id_fkey` FOREIGN KEY (`config_id`) REFERENCES `configurations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `config_revisions` ADD CONSTRAINT `config_revisions_config_id_fkey` FOREIGN KEY (`config_id`) REFERENCES `configurations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `config_revisions` ADD CONSTRAINT `config_revisions_generation_id_fkey` FOREIGN KEY (`generation_id`) REFERENCES `generation_attempts` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `config_secrets` ADD CONSTRAINT `config_secrets_config_id_fkey` FOREIGN KEY (`config_id`) REFERENCES `configurations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Durable global concurrency cap; claims lock one slot transactionally.
INSERT INTO `generation_slots` (`id`) VALUES (1), (2);
