-- CreateEnum
CREATE TYPE "ChannelSessionState" AS ENUM ('PENDING_SCAN', 'ACTIVE', 'EXPIRED', 'DISCONNECTED', 'BANNED');

-- AlterEnum
ALTER TYPE "ChannelKind" ADD VALUE 'WECHAT_PERSONAL_PROTOCOL';

-- AlterTable
ALTER TABLE "channel_bindings" ADD COLUMN     "bridgeSessionId" TEXT,
ADD COLUMN     "disconnectedReason" TEXT,
ADD COLUMN     "lastHeartbeatAt" TIMESTAMP(3),
ADD COLUMN     "sessionState" "ChannelSessionState" NOT NULL DEFAULT 'ACTIVE';
