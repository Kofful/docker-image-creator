ALTER TABLE `generation_attempts`
  ADD COLUMN `provider` VARCHAR(16) NOT NULL DEFAULT 'fake',
  ADD COLUMN `model` VARCHAR(128) NULL,
  ADD COLUMN `provider_responses` JSON NULL;
