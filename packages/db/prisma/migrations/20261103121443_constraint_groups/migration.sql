-- AlterTable
ALTER TABLE "fixed_constraints" ADD COLUMN     "groupId" TEXT;

-- CreateIndex
CREATE INDEX "fixed_constraints_userId_groupId_idx" ON "fixed_constraints"("userId", "groupId");
