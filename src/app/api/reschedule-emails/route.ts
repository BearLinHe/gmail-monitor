import { NextRequest, NextResponse } from "next/server";

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const region = searchParams.get("region")?.trim();
  const warehouse = searchParams.get("warehouse")?.trim();
  const emailAccount = searchParams.get("emailAccount")?.trim();
  const appointmentId = searchParams.get("appointmentId")?.trim();
  const limitRaw = searchParams.get("limit")?.trim();
  const limitNum = Number(limitRaw);
  const limit =
    Number.isFinite(limitNum) && limitNum > 0 ? Math.min(Math.floor(limitNum), 1000) : 200;

  const where: Prisma.AmazonRescheduleEmailWhereInput = {};

  if (region) {
    where.region = region;
  }
  if (warehouse) {
    where.warehouse = { contains: warehouse, mode: "insensitive" };
  }
  if (emailAccount) {
    where.emailAccount = emailAccount;
  }
  if (appointmentId) {
    where.appointmentId = { contains: appointmentId };
  }

  try {
    const rows = await prisma.amazonRescheduleEmail.findMany({
      where,
      orderBy: { receivedAt: "desc" },
      take: limit,
    });

    return NextResponse.json(
      { data: rows, limit },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Database error";
    console.error("[api/reschedule-emails]", message, e);
    return NextResponse.json({ error: message, data: [] }, { status: 500 });
  }
}
