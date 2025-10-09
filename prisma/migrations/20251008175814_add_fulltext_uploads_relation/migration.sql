-- AlterTable
ALTER TABLE `articles` ADD COLUMN `fullTextFileName` VARCHAR(191) NULL,
    ADD COLUMN `fullTextFilePath` VARCHAR(191) NULL,
    ADD COLUMN `fullTextUploadedAt` DATETIME(3) NULL,
    ADD COLUMN `fullTextUploadedById` VARCHAR(191) NULL;

-- AddForeignKey
ALTER TABLE `articles` ADD CONSTRAINT `articles_fullTextUploadedById_fkey` FOREIGN KEY (`fullTextUploadedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
