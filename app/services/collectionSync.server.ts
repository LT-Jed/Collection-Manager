import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { graphqlWithRetry } from "./graphqlWithRetry.server";
import db from "../db.server";
import {
  buildFullHierarchy,
  getProductHierarchyPath,
  getPublicationIds,
  publishCollectionToAllChannels,
  getTreeTypes,
  type ShopSettings,
  type BrandMode,
  type TreeType,
} from "./hierarchyBuilder.server";
import {
  setCollectionChildren,
  setParentCollection,
  setHierarchyLevel,
  setHierarchyTree,
  setProductBreadcrumbs,
  setProductUnbrandedBreadcrumbs,
} from "./metafieldManager.server";
import { handleCollectionRemoval, createRedirect } from "./redirectManager.server";

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

async function fetchProduct(
  admin: AdminApiContext,
  productGid: string,
) {
  const response: Response = await graphqlWithRetry(admin,
    `#graphql
    query GetProduct($id: ID!) {
      product(id: $id) {
        id
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
    id: product.id,
    vendor: product.vendor,
    productType: product.productType,
    metafields,
  };
}

async function createCollectionForNode(
  admin: AdminApiContext,
  title: string,
  handle: string,
): Promise<{ gid: string; handle: string } | null> {
  const response: Response = await graphqlWithRetry(admin,
    `#graphql
    mutation CreateCollection($input: CollectionInput!) {
      collectionCreate(input: $input) {
        collection { id handle }
        userErrors { field message }
      }
    }`,
    { variables: { input: { title, handle } } },
  );
  const json: any = await response.json();
  const errors = json.data?.collectionCreate?.userErrors;
  if (errors?.length) {
    if (
      errors.some((e: { message: string }) => e.message.includes("already"))
    ) {
      const findResp: Response = await graphqlWithRetry(admin,
        `#graphql
        query FindCollection($handle: String!) {
          collectionByHandle(handle: $handle) { id handle }
        }`,
        { variables: { handle } },
      );
      const findJson: any = await findResp.json();
      const c = findJson.data?.collectionByHandle;
      return c ? { gid: c.id, handle: c.handle } : null;
    }
    console.error("Failed to create collection:", errors);
    return null;
  }
  const c = json.data?.collectionCreate?.collection;
  if (c) {
    const pubIds = await getPublicationIds(admin);
    await publishCollectionToAllChannels(admin, c.id, pubIds);
    return { gid: c.id, handle: c.handle };
  }
  return null;
}

async function addProductToCollection(
  admin: AdminApiContext,
  collectionGid: string,
  productGid: string,
) {
  await graphqlWithRetry(admin,
    `#graphql
    mutation AddProduct($id: ID!, $productIds: [ID!]!) {
      collectionAddProducts(id: $id, productIds: $productIds) {
        collection { id }
        userErrors { field message }
      }
    }`,
    { variables: { id: collectionGid, productIds: [productGid] } },
  );
}

async function removeProductFromCollection(
  admin: AdminApiContext,
  collectionGid: string,
  productGid: string,
) {
  await graphqlWithRetry(admin,
    `#graphql
    mutation RemoveProduct($id: ID!, $productIds: [ID!]!) {
      collectionRemoveProducts(id: $id, productIds: $productIds) {
        userErrors { field message }
      }
    }`,
    { variables: { id: collectionGid, productIds: [productGid] } },
  );
}

async function getProductCollections(
  admin: AdminApiContext,
  productGid: string,
): Promise<string[]> {
  const collectionGids: string[] = [];
  let cursor: string | null = null;
  let hasNext = true;

  while (hasNext) {
    const response: Response = await graphqlWithRetry(admin,
      `#graphql
      query ProductCollections($id: ID!, $after: String) {
        product(id: $id) {
          collections(first: 50, after: $after) {
            edges {
              node { id }
              cursor
            }
            pageInfo { hasNextPage }
          }
        }
      }`,
      { variables: { id: productGid, after: cursor } },
    );
    const json: any = await response.json();
    const collections = json.data?.product?.collections;
    if (!collections) break;

    for (const edge of collections.edges) {
      collectionGids.push(edge.node.id);
      cursor = edge.cursor;
    }
    hasNext = collections.pageInfo.hasNextPage;
  }

  return collectionGids;
}

/**
 * Walk the hierarchy path for a product within a specific tree type,
 * creating nodes/collections as needed. Returns the collection GIDs along the path.
 */
async function syncProductForTree(
  admin: AdminApiContext,
  shopId: string,
  productGid: string,
  settings: ShopSettings,
  treeType: TreeType,
  eventType: "create" | "update",
): Promise<string[]> {
  const product = await fetchProduct(admin, productGid);
  if (!product) return [];

  const newPath = getProductHierarchyPath(product, settings, treeType);
  let parentDbId: string | null = null;
  let parentHandle: string | undefined;
  const collectionGidsForBreadcrumb: string[] = [];

  for (const entry of newPath) {
    const slug = entry.value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    let handle: string;
    if (parentHandle) {
      handle = `${parentHandle}-${slug}`;
    } else {
      handle = treeType === "unbranded" ? `all-${slug}` : slug;
    }

    const node: {
      id: string;
      collectionGid: string | null;
      collectionHandle: string | null;
      productCount: number;
    } = await db.hierarchyNode.upsert({
      where: {
        shopId_level_value_parentId_treeType: {
          shopId,
          level: entry.level,
          value: entry.value,
          parentId: parentDbId ?? "",
          treeType,
        },
      },
      create: {
        shopId,
        level: entry.level,
        levelName: entry.levelName,
        value: entry.value,
        parentId: parentDbId ?? "",
        treeType,
        productCount: 1,
        isActive: true,
      },
      update: {
        productCount: { increment: eventType === "create" ? 1 : 0 },
      },
    });

    // Create collection if needed
    if (
      !node.collectionGid &&
      node.productCount >= settings.minProductThreshold
    ) {
      const title = entry.value; // simplified for incremental
      const result = await createCollectionForNode(admin, title, handle);
      if (result) {
        await db.hierarchyNode.update({
          where: { id: node.id },
          data: {
            collectionGid: result.gid,
            collectionHandle: result.handle,
          },
        });
        node.collectionGid = result.gid;
        node.collectionHandle = result.handle;

        await setHierarchyLevel(admin, result.gid, entry.levelName);
        if (treeType !== "single") {
          await setHierarchyTree(admin, result.gid, treeType);
        }
        if (parentDbId) {
          const parentNode: { collectionGid: string | null } | null =
            await db.hierarchyNode.findUnique({
              where: { id: parentDbId },
            });
          if (parentNode?.collectionGid) {
            await setParentCollection(
              admin,
              result.gid,
              parentNode.collectionGid,
            );
          }
        }
      }
    }

    // Add product to collection
    if (node.collectionGid) {
      await addProductToCollection(admin, node.collectionGid, productGid);
      collectionGidsForBreadcrumb.push(node.collectionGid);
    }

    // Update parent's children_data
    if (parentDbId && node.collectionGid) {
      const siblings = await db.hierarchyNode.findMany({
        where: {
          shopId,
          parentId: parentDbId,
          isActive: true,
          collectionHandle: { not: null },
        },
        select: { collectionHandle: true },
      });
      const parentNode: { collectionGid: string | null } | null =
        await db.hierarchyNode.findUnique({
          where: { id: parentDbId },
        });
      if (parentNode?.collectionGid) {
        await setCollectionChildren(
          admin,
          parentNode.collectionGid,
          siblings
            .map((s) => s.collectionHandle)
            .filter((h): h is string => h !== null),
        );
      }
    }

    parentDbId = node.id;
    parentHandle = node.collectionHandle ?? handle;
  }

  return collectionGidsForBreadcrumb;
}

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
    if (eventType === "delete") {
      // Remove product from all managed collections
      const nodes = await db.hierarchyNode.findMany({
        where: { shopId: shop.id, isActive: true, collectionGid: { not: null } },
      });
      for (const node of nodes) {
        if (node.collectionGid) {
          await removeProductFromCollection(
            admin,
            node.collectionGid,
            productGid,
          );
        }
      }

      // Create a redirect from the product URL to the deepest collection
      // in the default tree (branded/unbranded based on shop setting)
      if (productHandle) {
        const defaultTree =
          settings.brandMode === "both"
            ? (settings.defaultBreadcrumbTree === "unbranded"
                ? "unbranded"
                : "branded")
            : settings.brandMode === "no_brand"
              ? "single"
              : "single";

        // Find the deepest active node with a collection in the default tree
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
    } else {
      // create or update
      const treeTypes = getTreeTypes(settings.brandMode);

      // For updates: find which managed collections this product is currently in
      let oldCollectionGids: Set<string> | null = null;
      if (eventType === "update") {
        const currentGids = await getProductCollections(admin, productGid);
        const managedNodes = await db.hierarchyNode.findMany({
          where: {
            shopId: shop.id,
            isActive: true,
            collectionGid: { not: null },
          },
          select: { collectionGid: true },
        });
        const managedGids = new Set(
          managedNodes
            .map((n) => n.collectionGid)
            .filter((g): g is string => g !== null),
        );
        oldCollectionGids = new Set(
          currentGids.filter((g) => managedGids.has(g)),
        );
      }

      const newCollectionGids = new Set<string>();

      if (settings.brandMode === "both") {
        // Sync both trees, set both breadcrumb metafields
        const brandedGids = await syncProductForTree(
          admin,
          shop.id,
          productGid,
          settings,
          "branded",
          eventType,
        );
        const unbrandedGids = await syncProductForTree(
          admin,
          shop.id,
          productGid,
          settings,
          "unbranded",
          eventType,
        );

        for (const gid of [...brandedGids, ...unbrandedGids]) {
          newCollectionGids.add(gid);
        }

        if (brandedGids.length > 0) {
          await setProductBreadcrumbs(admin, productGid, brandedGids);
        }
        if (unbrandedGids.length > 0) {
          await setProductUnbrandedBreadcrumbs(
            admin,
            productGid,
            unbrandedGids,
          );
        }
      } else {
        // Single tree
        const treeType = treeTypes[0];
        const gids = await syncProductForTree(
          admin,
          shop.id,
          productGid,
          settings,
          treeType,
          eventType,
        );
        for (const gid of gids) {
          newCollectionGids.add(gid);
        }
        if (gids.length > 0) {
          await setProductBreadcrumbs(admin, productGid, gids);
        }
      }

      // Remove product from old managed collections it no longer belongs to
      if (oldCollectionGids) {
        for (const oldGid of oldCollectionGids) {
          if (!newCollectionGids.has(oldGid)) {
            await removeProductFromCollection(admin, oldGid, productGid);
            await db.hierarchyNode.updateMany({
              where: { shopId: shop.id, collectionGid: oldGid },
              data: { productCount: { decrement: 1 } },
            });
          }
        }
      }
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
