CREATE TABLE `terminal_tickets` (
    `id` CHAR(36) NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `session_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `config_id` CHAR(36) NOT NULL,
    `revision_id` CHAR(36) NOT NULL,
    `operation_id` CHAR(36) NOT NULL,
    `service` VARCHAR(40) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `used_at` DATETIME(3) NULL,
    UNIQUE INDEX `terminal_tickets_token_hash_key` (`token_hash`),
    INDEX `terminal_tickets_expires_at_idx` (`expires_at`),
    PRIMARY KEY (`id`),
    CONSTRAINT `terminal_tickets_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `terminal_tickets_config_id_fkey` FOREIGN KEY (`config_id`) REFERENCES `configurations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
