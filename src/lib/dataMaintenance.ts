import { prisma } from "@/lib/prisma";

const THROTTLE_TABLE_NAME = "scan_notification_throttle";

function retentionDays(): number {
  const raw = process.env.DATA_RETENTION_DAYS?.trim();
  if (!raw) return 14;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 14;
  return Math.min(n, 3650);
}

export type MaintenanceResult = {
  retentionDays: number;
  deletedRows: number;
  deletedThrottleRows: number;
};

/**
 * Deletes old monitor data to keep scans and list queries fast over long periods.
 * Runs safely even if throttle table has not been created yet.
 */
export async function cleanupOldData(): Promise<MaintenanceResult> {
  const days = retentionDays();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const deleted = await prisma.amazonRescheduleEmail.deleteMany({
    where: {
      receivedAt: { lt: cutoff },
    },
  });

  const tableRows = (await prisma.$queryRawUnsafe(
    "SELECT to_regclass('public.scan_notification_throttle')::text AS name",
  )) as Array<{ name: string | null }>;
  let deletedThrottleRows = 0;
  if (tableRows[0]?.name === THROTTLE_TABLE_NAME) {
    deletedThrottleRows = await prisma.$executeRawUnsafe(
      "DELETE FROM scan_notification_throttle WHERE last_notified_at < $1::timestamptz",
      cutoff.toISOString(),
    );
  }

  return {
    retentionDays: days,
    deletedRows: deleted.count,
    deletedThrottleRows,
  };
}
