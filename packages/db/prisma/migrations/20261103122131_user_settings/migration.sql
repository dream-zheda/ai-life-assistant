-- CreateTable
CREATE TABLE "user_settings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "briefStartTime" VARCHAR(5) NOT NULL DEFAULT '07:00',
    "reminderLeadMinutes" INTEGER NOT NULL DEFAULT 10,
    "quietHoursStart" VARCHAR(5),
    "quietHoursEnd" VARCHAR(5),
    "remindersPaused" BOOLEAN NOT NULL DEFAULT false,
    "maxRemindersPerDay" INTEGER NOT NULL DEFAULT 8,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_settings_userId_key" ON "user_settings"("userId");

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
