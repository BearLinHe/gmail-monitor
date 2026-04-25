-- CreateTable
CREATE TABLE "AmazonRescheduleEmail" (
    "id" TEXT NOT NULL,
    "emailAccount" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "warehouse" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "appointmentTimeText" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmazonRescheduleEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AmazonRescheduleEmail_gmailMessageId_key" ON "AmazonRescheduleEmail"("gmailMessageId");

-- CreateIndex
CREATE INDEX "AmazonRescheduleEmail_receivedAt_idx" ON "AmazonRescheduleEmail"("receivedAt" DESC);

-- CreateIndex
CREATE INDEX "AmazonRescheduleEmail_region_idx" ON "AmazonRescheduleEmail"("region");

-- CreateIndex
CREATE INDEX "AmazonRescheduleEmail_warehouse_idx" ON "AmazonRescheduleEmail"("warehouse");

-- CreateIndex
CREATE INDEX "AmazonRescheduleEmail_emailAccount_idx" ON "AmazonRescheduleEmail"("emailAccount");

-- CreateIndex
CREATE INDEX "AmazonRescheduleEmail_appointmentId_idx" ON "AmazonRescheduleEmail"("appointmentId");
