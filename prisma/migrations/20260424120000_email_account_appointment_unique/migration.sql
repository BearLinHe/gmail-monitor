-- Keep one row per (emailAccount, appointmentId): retain the latest receivedAt (IMAP internal date).
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY "emailAccount", "appointmentId"
           ORDER BY "receivedAt" DESC, "id" DESC
         ) AS rn
  FROM "AmazonRescheduleEmail"
)
DELETE FROM "AmazonRescheduleEmail" a
USING ranked r
WHERE a."id" = r.id AND r.rn > 1;

DROP INDEX IF EXISTS "AmazonRescheduleEmail_gmailMessageId_key";

CREATE INDEX "AmazonRescheduleEmail_gmailMessageId_idx" ON "AmazonRescheduleEmail"("gmailMessageId");

CREATE UNIQUE INDEX "AmazonRescheduleEmail_emailAccount_appointmentId_key"
ON "AmazonRescheduleEmail"("emailAccount", "appointmentId");
