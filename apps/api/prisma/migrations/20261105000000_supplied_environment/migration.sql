ALTER TABLE `configurations` ADD COLUMN `input_version` INTEGER NOT NULL DEFAULT 1;

CREATE TABLE `supplied_environment_values` (
  `id` CHAR(36) NOT NULL,
  `config_id` CHAR(36) NOT NULL,
  `reference` VARCHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `purpose` VARCHAR(500) NOT NULL,
  `value_encrypted` TEXT NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `supplied_environment_values_reference_key` (`reference`),
  UNIQUE INDEX `supplied_environment_values_id_config_id_key` (`id`, `config_id`),
  INDEX `supplied_environment_values_config_id_idx` (`config_id`),
  CONSTRAINT `supplied_environment_values_config_id_fkey` FOREIGN KEY (`config_id`) REFERENCES `configurations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `service_environment_bindings` (
  `id` CHAR(36) NOT NULL,
  `config_id` CHAR(36) NOT NULL,
  `value_id` CHAR(36) NOT NULL,
  `service` VARCHAR(30) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `name` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `service_environment_bindings_config_id_service_name_key` (`config_id`, `service`, `name`),
  INDEX `service_environment_bindings_value_id_config_id_idx` (`value_id`, `config_id`),
  CONSTRAINT `service_environment_bindings_value_id_config_id_fkey` FOREIGN KEY (`value_id`, `config_id`) REFERENCES `supplied_environment_values` (`id`, `config_id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
