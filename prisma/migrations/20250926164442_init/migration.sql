/*
  Warnings:

  - You are about to drop the `article` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE `article` DROP FOREIGN KEY `Article_projectId_fkey`;

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
DROP TABLE `article`;

-- CreateTable
CREATE TABLE `articles` (
    `id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `abstract` VARCHAR(191) NULL,
    `journal` VARCHAR(191) NULL,
    `year` INTEGER NULL,
    `doi` VARCHAR(191) NULL,
    `pmid` VARCHAR(191) NULL,
    `url` VARCHAR(191) NULL,
    `date` DATETIME(3) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Author` ADD CONSTRAINT `Author_articleId_fkey` FOREIGN KEY (`articleId`) REFERENCES `articles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `articles` ADD CONSTRAINT `articles_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PublicationType` ADD CONSTRAINT `PublicationType_articleId_fkey` FOREIGN KEY (`articleId`) REFERENCES `articles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Topic` ADD CONSTRAINT `Topic_articleId_fkey` FOREIGN KEY (`articleId`) REFERENCES `articles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
