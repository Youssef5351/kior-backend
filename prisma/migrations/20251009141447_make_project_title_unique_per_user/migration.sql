/*
  Warnings:

  - A unique constraint covering the columns `[title,ownerId]` on the table `projects` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX `projects_title_key` ON `projects`;

-- CreateIndex
CREATE UNIQUE INDEX `projects_title_ownerId_key` ON `projects`(`title`, `ownerId`);
