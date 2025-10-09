/*
  Warnings:

  - You are about to drop the column `name` on the `publicationtype` table. All the data in the column will be lost.
  - You are about to drop the column `name` on the `topic` table. All the data in the column will be lost.
  - Added the required column `value` to the `PublicationType` table without a default value. This is not possible if the table is not empty.
  - Added the required column `value` to the `Topic` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `articles` ADD COLUMN `date` DATETIME(3) NULL,
    ADD COLUMN `pmid` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `publicationtype` DROP COLUMN `name`,
    ADD COLUMN `value` VARCHAR(191) NOT NULL;

-- AlterTable
ALTER TABLE `topic` DROP COLUMN `name`,
    ADD COLUMN `value` VARCHAR(191) NOT NULL;
