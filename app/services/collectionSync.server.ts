import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { graphqlWithRetry } from "./graphqlWithRetry.server";
import db from "../db.server";
import {
  buildFullHierarchy,
  type ShopSettings,
  type BrandMode,
} from "./hierarchyBuilder.server";
import { reconcileProductMembership } from "./membershipSync.server";
import { handleCollectionRemoval, createRedirect } from "./redirectManager.server";
import { syncSeparateCollections } from "./separateCollections.server";
import { SyncProgress, TOTAL_SYNC_PHASES } from "./syncProgress.server";

async function getOrCreateShop(shopDomain: string) {
  return db.shop.upsert({
    where: { shopDomain },
    create: { shopDomain },
    update: {},
  });
}

function shopToSettings(shop: {
  id: string;
  brandMode: string;
  defaultBreadcrumbTree: string;
  minProductThreshold: number;
  artistEnabled: boolean;
  lineEnabled: boolean;
  collectionEnabled: boolean;
}): ShopSettings {
  return {
    id: shop.id,
    brandMode: shop.brandMode as BrandMode,
    defaultBreadcrumbTree: shop.defaultBreadcrumbTree,
    minProductThreshold: shop.minProductThreshold,
    artistEnabled: shop.artistEnabled,
    lineEnabled: shop.lineEnabled,
    collectionEnabled: shop.collectionEnabled,
  };
}

async function fetchProduct(admin: AdminApiContext, productGid: string) {
  const response: Response = await graphqlWithRetry(admin,
    `#graphql
    query GetProduct($id: ID!) {
      product(id: $id) {
        id
        status
        vendor
        productType
        metafields(first: 20, namespace: "custom") {
          edges {
            node { key value }
          }
        }
      }
    }`,
    { variables: { id: productGid } },
  );
  const json: any = await response.json();
  const product = json.data?.product;
  if (!product) return null;

  const metafields = new Map<string, string>();
  for (const edge of product.metafields.edges) {
    metafields.set(edge.node.key, edge.node.value);
  }

  return {
    id: product.id as string,
    status: product.status as string,
    vendor: product.vendor as string,
    productType: product.productType as string,
    metafields,
  };
}

/**
 * Handle a product create/update/delete webhook. All collection membership and
 * counts (hierarchy + standalone) are reconciled incrementally from the DB
 * membership table, so a full sync is never required for ongoing changes.
 */
export async function syncProduct(
  admin: AdminApiContext,
  shopDomain: string,
  productGid: string,
  eventType: "create" | "update" | "delete",
  productHandle?: string,
) {
  const shop = await getOrCreateShop(shopDomain);
  const settings = shopToSettings(shop);

  const job = await db.collectionSyncJob.create({
    data: {
      shopId: shop.id,
      triggeredBy: "webhook",
      status: "running",
    },
  });

  try {
    const product =
      eventType === "delete" ? null : await fetchProduct(admin, productGid);
    if (eventType !== "delete" && !product) {
      await db.collectionSyncJob.update({
        where: { id: job.id },
        data: { status: "completed" },
      });
      return;
    }

    await reconcileProductMembership(
      admin,
      shop.id,
      settings,
      productGid,
      product,
      eventType,
    );

    // Redirect the deleted product's URL to the deepest remaining collection in
    // the default tree.
    if (eventType === "delete" && productHandle) {
      const defaultTree =
        settings.brandMode === "both"
          ? settings.defaultBreadcrumbTree === "unbranded"
            ? "unbranded"
            : "branded"
          : "single";

      const deepestNode = await db.hierarchyNode.findFirst({
        where: {
          shopId: shop.id,
          isActive: true,
          collectionHandle: { not: null },
          treeType: defaultTree,
          level: { lt: 100 }, // exclude standalone
        },
        orderBy: { level: "desc" },
      });

      const toPath = deepestNode?.collectionHandle
        ? `/collections/${deepestNode.collectionHandle}`
        : "/collections";

      await createRedirect(
        admin,
        shop.id,
        `/products/${productHandle}`,
        toPath,
        "product_deleted",
      );
    }

    await db.collectionSyncJob.update({
      where: { id: job.id },
      data: { status: "completed" },
    });
  } catch (error) {
    console.error("Sync product failed:", error);
    await db.collectionSyncJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        details: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

export async function handleCollectionDelete(
  admin: AdminApiContext,
  shopDomain: string,
  collectionGid: string,
) {
  const shop = await getOrCreateShop(shopDomain);

  const node: {
    id: string;
    collectionGid: string | null;
    collectionHandle: string | null;
    parentId: string | null;
  } | null = await db.hierarchyNode.findFirst({
    where: { shopId: shop.id, collectionGid, isActive: true },
  });

  if (!node) return;

  await handleCollectionRemoval(admin, shop.id, {
    id: node.id,
    collectionGid: node.collectionGid,
    collectionHandle: node.collectionHandle,
    parentId: node.parentId,
  });
}

export async function runFullSync(
  admin: AdminApiContext,
  shopDomain: string,
) {
  const shop = await getOrCreateShop(shopDomain);

  const job = await db.collectionSyncJob.create({
    data: {
      shopId: shop.id,
      triggeredBy: "manual",
      status: "running",
    },
  });

  try {
    const result = await buildFullHierarchy(admin, shopDomain);

    await db.collectionSyncJob.update({
      where: { id: job.id },
      data: {
        status: "completed",
        details: JSON.stringify(result),
      },
    });

    return result;
  } catch (error) {
    console.error("Full sync failed:", error);
    await db.collectionSyncJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        details: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

// Create a sync job row in the "running" state and return its id. The caller
// kicks off runFullSyncJob (detached) so the HTTP request can return
// immediately while the page polls this job's progress.
export async function startFullSyncJob(shopDomain: string): Promise<string> {
  const shop = await getOrCreateShop(shopDomain);
  const job = await db.collectionSyncJob.create({
    data: {
      shopId: shop.id,
      triggeredBy: "manual",
      status: "running",
      phaseCount: TOTAL_SYNC_PHASES,
      phaseLabel: "Starting…",
    },
  });
  return job.id;
}

// Run a full sync against an existing job row, reporting progress as it goes.
// Runs the hierarchy build and the separate-collection sync under one job so the
// progress bar spans the whole operation. `getAdmin` is called to (re)acquire an
// admin client — it is retried once if the token expires mid-sync, so the job is
// only marked failed after that retry is exhausted.
export async function runFullSyncJob(
  shopDomain: string,
  jobId: string,
  getAdmin: () => Promise<AdminApiContext>,
) {
  const progress = new SyncProgress(jobId, TOTAL_SYNC_PHASES);

  const runOnce = async (admin: AdminApiContext) => {
    const result = await buildFullHierarchy(admin, shopDomain, progress);
    await syncSeparateCollections(admin, shopDomain, progress);
    return result;
  };

  // Keep the job row's updatedAt fresh while the sync runs. Long phases (e.g.
  // building the hierarchy) don't emit per-item ticks, so without this the UI's
  // stall detector would fire mid-sync. The interval fires between awaits, so it
  // stops naturally if the process dies — which is exactly when a real stall
  // should be reported.
  const heartbeat = setInterval(() => {
    void progress.heartbeat();
  }, 15000);

  try {
    let result;
    try {
      result = await runOnce(await getAdmin());
    } catch (error: any) {
      if (
        error?.response?.code === 401 ||
        error?.message?.includes("Unauthorized")
      ) {
        console.log("Token expired during sync, re-acquiring and retrying...");
        result = await runOnce(await getAdmin());
      } else {
        throw error;
      }
    }

    await db.collectionSyncJob.update({
      where: { id: jobId },
      data: {
        status: "completed",
        details: JSON.stringify(result),
        phaseLabel: "Completed",
      },
    });
    return result;
  } catch (error) {
    console.error("Full sync failed:", error);
    await db.collectionSyncJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        details: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
