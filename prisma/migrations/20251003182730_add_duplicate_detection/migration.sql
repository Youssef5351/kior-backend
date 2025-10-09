-- AlterTable
ALTER TABLE `articles` ADD COLUMN `duplicateStatus` VARCHAR(191) NULL,
    ADD COLUMN `resolvedAt` DATETIME(3) NULL,
    ADD COLUMN `resolvedBy` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `duplicate_detections` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `detectedAt` DATETIME(3) NOT NULL,
    `totalGroups` INTEGER NOT NULL,
    `totalArticles` INTEGER NOT NULL,
    `results` JSON NOT NULL,

    UNIQUE INDEX `duplicate_detections_projectId_key`(`projectId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `duplicate_detections` ADD CONSTRAINT `duplicate_detections_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
