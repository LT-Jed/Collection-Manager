import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Lightweight polling endpoint for the dashboard progress bar. Returns just the
// latest sync job's progress fields — intentionally cheaper than the index
// loader (which rebuilds the whole hierarchy tree).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await db.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });
  if (!shop) return { job: null };

  const job = await db.collectionSyncJob.findFirst({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      phaseLabel: true,
      phaseNumber: true,
      phaseCount: true,
      processed: true,
      total: true,
      details: true,
      updatedAt: true,
    },
  });

  if (!job) return { job: null };

  return {
    job: {
      id: job.id,
      status: job.status,
      phaseLabel: job.phaseLabel,
      phaseNumber: job.phaseNumber,
      phaseCount: job.phaseCount,
      processed: job.processed,
      total: job.total,
      // Only surface details for a failed job (the error message).
      error: job.status === "failed" ? job.details : null,
      updatedAt: job.updatedAt.toISOString(),
    },
  };
};
