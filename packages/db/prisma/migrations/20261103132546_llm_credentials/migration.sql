-- AlterTable
ALTER TABLE "user_settings" ADD COLUMN     "llmApiKeyCipher" TEXT,
ADD COLUMN     "llmApiKeyHint" VARCHAR(8),
ADD COLUMN     "llmBaseUrl" TEXT,
ADD COLUMN     "llmModel" TEXT,
ADD COLUMN     "llmProvider" TEXT,
ADD COLUMN     "llmUpdatedAt" TIMESTAMP(3);
