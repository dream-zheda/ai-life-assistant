CREATE TABLE "qq_link_codes" (
  "userId" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "qq_link_codes_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "qq_link_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "qq_link_codes_codeHash_key" ON "qq_link_codes"("codeHash");
