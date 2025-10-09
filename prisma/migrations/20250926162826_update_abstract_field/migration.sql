/*
  Warnings:

  - You are about to drop the `articles` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE `articles` DROP FOREIGN KEY `articles_projectId_fkey`;

-- DropForeignKey
ALTER TABLE `author` DROP FOREIGN KEY `Author_articleId_fkey`;

-- DropForeignKey
ALTER TABLE `publicationtype` DROP FOREIGN KEY `PublicationType_articleId_fkey`;

-- DropForeignKey
ALTER TABLE `topic` DROP FOREIGN KEY `Topic_articleId_fkey`;

-- DropIndex
DROP INDEX `Author_articleId_fkey` ON `author`;

-- DropIndex
DROP INDEX `PublicationType_articleId_fkey` ON `publicationtype`;

-- DropIndex
DROP INDEX `Topic_articleId_fkey` ON `topic`;

-- DropTable
DROP TABLE `articles`;

-- CreateTable
CREATE TABLE `Article` (
    `id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `abstract` TEXT NOT NULL,
    `journal` VARCHAR(191) NULL,
    `year` INTEGER NULL,
    `date` DATETIME(3) NULL,
    `volume` VARCHAR(191) NULL,
    `issue` VARCHAR(191) NULL,
    `pages` VARCHAR(191) NULL,
    `doi` VARCHAR(191) NULL,
    `url` VARCHAR(191) NULL,
    `status` VARCHAR(191) NULL DEFAULT 'Include',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Author` ADD CONSTRAINT `Author_articleId_fkey` FOREIGN KEY (`articleId`) REFERENCES `Article`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Article` ADD CONSTRAINT `Article_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PublicationType` ADD CONSTRAINT `PublicationType_articleId_fkey` FOREIGN KEY (`articleId`) REFERENCES `Article`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Topic` ADD CONSTRAINT `Topic_articleId_fkey` FOREIGN KEY (`articleId`) REFERENCES `Article`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
