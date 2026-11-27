CREATE TABLE "GmailConnection" (
    "email" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "encryptedRefreshToken" TEXT NOT NULL,
    "authorizationId" TEXT NOT NULL,
    "needsReconnect" BOOLEAN NOT NULL DEFAULT false,
    "lastScanAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GmailConnection_pkey" PRIMARY KEY ("email")
);
