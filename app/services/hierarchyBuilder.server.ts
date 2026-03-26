import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { graphqlWithRetry } from "./graphqlWithRetry.server";
import db from "../db.server";
import {
  ensureMetafieldDefinitions,
  setCollectionChildren,
  setParentCollection,
  setHierarchyLevel,
  setHierarchyTree,
  setProductBreadcrumbs,
  setProductUnbrandedBreadcrumbs,
} from "./metafieldManager.server";
import { handleCollectionRemoval } from "./redirectManager.server";

export type BrandMode = "brand_only" | "no_brand" | "both";
export type TreeType = "single" | "branded" | "unbranded";

export interface ShopSettings {
  id: string;
  brandMode: BrandMode;
  defaultBreadcrumbTree: string;
  minProductThreshold: number;
  artistEnabled: boolean;
  lineEnabled: boolean;
  collectionEnabled: boolean;
}

export const HIERARCHY_LEVELS = [
  { level: 1, name: "Brand", field: "vendor" as const },
  { level: 2, name: "Category", field: "productType" as const },
  {
    level: 3,
    name: "Occasion",
    metafield: "custom.occasion" as const,
  },
  { level: 4, name: "Tone", metafield: "custom.tone" as const },
  {
    level: 5,
    name: "For",
    metafield: "custom.recipient_gender" as const,
  },
  {
    level: 6,
    name: "Recipient",
    metafield: "custom.recipient_group" as const,
  },
  {
    level: 7,
    name: "Age Group",
    metafield: "custom.recipient_kid" as const,
  },
] as const;

interface ProductData {
  id: string;
  vendor: string;
  productType: string;
  metafields: Map<string, string>;
}

interface TreeNode {
  level: number;
  levelName: string;
  value: string;
  productIds: Set<string>;
  children: Map<string, TreeNode>;
}

/**
 * Determine whether brand level should be included for a given tree type.
 */
function shouldIncludeBrand(brandMode: BrandMode, treeType: TreeType): boolean {
  if (brandMode === "brand_only") return true;
  if (brandMode === "no_brand") return false;
  // brandMode === "both"
  return treeType === "branded";
}

/**
 * Get the tree types that should be built for a given brand mode.
 */
export function getTreeTypes(brandMode: BrandMode): TreeType[] {
  if (brandMode === "both") return ["branded", "unbranded"];
  return ["single"];
}

export function getProductHierarchyPath(
  product: ProductData,
  settings: ShopSettings,
  treeType: TreeType = "single",
): Array<{ level: number; levelName: string; value: string }> {
  const path: Array<{ level: number; levelName: string; value: string }> = [];
  const includeBrand = shouldIncludeBrand(settings.brandMode, treeType);

  for (const levelDef of HIERARCHY_LEVELS) {
    // Skip Brand level based on mode/treeType
    if (levelDef.level === 1 && !includeBrand) continue;

    let value: string | undefined;
    if ("field" in levelDef) {
      value = product[levelDef.field];
    } else {
      const key = levelDef.metafield.split(".")[1];
      value = product.metafields.get(key);
    }

    // For recipient_kid boolean: only create "Kids" subcollection
    if (levelDef.level === 7) {
      if (value === "true" || value === "1") {
        value = "Kids";
      } else {
        continue;
      }
    }

    if (value && value.trim()) {
      path.push({
        level: levelDef.level,
        levelName: levelDef.name,
        value: value.trim(),
      });
    }
  }

  return path;
}

async function fetchAllProducts(
  admin: AdminApiContext,
): Promise<ProductData[]> {
  const products: ProductData[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response: Response = await graphqlWithRetry(admin,
      `#graphql
      query GetProducts($cursor: String) {
        products(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              vendor
              productType
              metafields(first: 20, namespace: "custom") {
                edges {
                  node { key value }
                }
              }
            }
          }
        }
      }`,
      { variables: { cursor } },
    );
    const json: any = await response.json();
    const data = json.data?.products;
    if (!data) break;

    for (const edge of data.edges) {
      const node = edge.node;
      const metafields = new Map<string, string>();
      for (const mfEdge of node.metafields.edges) {
        metafields.set(mfEdge.node.key, mfEdge.node.value);
      }
      products.push({
        id: node.id,
        vendor: node.vendor,
        productType: node.productType,
        metafields,
      });
    }

    hasNextPage = data.pageInfo.hasNextPage;
    cursor = data.pageInfo.endCursor;
  }

  return products;
}

function buildTree(
  products: ProductData[],
  settings: ShopSettings,
  treeType: TreeType,
): { root: Map<string, TreeNode>; productPaths: Map<string, string[]> } {
  const root = new Map<string, TreeNode>();
  const productPaths = new Map<string, string[]>();

  for (const product of products) {
    const path = getProductHierarchyPath(product, settings, treeType);
    if (path.length === 0) continue;

    const pathKeys: string[] = [];
    let currentLevel = root;

    for (const entry of path) {
      const key = `${entry.level}:${entry.value}`;
      pathKeys.push(key);

      if (!currentLevel.has(key)) {
        currentLevel.set(key, {
          level: entry.level,
          levelName: entry.levelName,
          value: entry.value,
          productIds: new Set(),
          children: new Map(),
        });
      }
      const node: TreeNode = currentLevel.get(key)!;
      node.productIds.add(product.id);
      currentLevel = node.children;
    }

    productPaths.set(product.id, pathKeys);
  }

  return { root, productPaths };
}

function generateCollectionTitle(
  value: string,
  parentTitle?: string,
): string {
  return parentTitle ? `${parentTitle} > ${value}` : value;
}

function generateCollectionHandle(
  levelName: string,
  value: string,
  parentHandle?: string,
  treeType: TreeType = "single",
): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  let handle: string;
  if (parentHandle) {
    handle = `${parentHandle}-${slug}`;
  } else {
    handle = slug;
  }

  // For unbranded trees, prefix root-level collections with "all-" to avoid handle collisions
  if (treeType === "unbranded" && !parentHandle) {
    handle = `all-${handle}`;
  }

  return handle;
}

export async function getPublicationIds(
  admin: AdminApiContext,
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response: Response = await graphqlWithRetry(admin,
      `#graphql
      query Publications($after: String) {
        publications(first: 50, after: $after) {
          edges { node { id } cursor }
          pageInfo { hasNextPage }
        }
      }`,
      { variables: { after: cursor } },
    );
    const json: any = await response.json();
    const publications = json.data?.publications;
    if (!publications) break;
    for (const edge of publications.edges) {
      ids.push(edge.node.id);
    }
    hasNextPage = publications.pageInfo.hasNextPage;
    if (publications.edges.length > 0) {
      cursor = publications.edges[publications.edges.length - 1].cursor;
    } else {
      hasNextPage = false;
    }
  }

  return ids;
}

export async function publishCollectionToAllChannels(
  admin: AdminApiContext,
  collectionGid: string,
  publicationIds: string[],
) {
  if (publicationIds.length === 0) return;

  const response: Response = await graphqlWithRetry(admin,
    `#graphql
    mutation PublishCollection($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        userErrors { field message }
      }
    }`,
    {
      variables: {
        id: collectionGid,
        input: publicationIds.map((pubId) => ({ publicationId: pubId })),
      },
    },
  );
  const json: any = await response.json();
  const errors = json.data?.publishablePublish?.userErrors;
  if (errors?.length) {
    console.error("Failed to publish collection:", errors);
  }
}

async function createShopifyCollection(
  admin: AdminApiContext,
  title: string,
  handle: string,
  publicationIds: string[],
): Promise<{ gid: string; handle: string } | null> {
  const response: Response = await graphqlWithRetry(admin,
    `#graphql
    mutation CreateCollection($input: CollectionInput!) {
      collectionCreate(input: $input) {
        collection { id handle title }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        input: { title, handle },
      },
    },
  );
  const json: any = await response.json();
  const errors = json.data?.collectionCreate?.userErrors;
  if (errors?.length) {
    if (
      errors.some((e: { message: string }) => e.message.includes("already"))
    ) {
      const existing = await findCollectionByHandle(admin, handle);
      if (existing) return existing;
      return await createShopifyCollection(
        admin,
        title,
        `${handle}-manual`,
        publicationIds,
      );
    }
    console.error("Failed to create collection:", errors);
    return null;
  }
  const collection = json.data?.collectionCreate?.collection;
  if (collection) {
    await publishCollectionToAllChannels(admin, collection.id, publicationIds);
    return { gid: collection.id, handle: collection.handle };
  }
  return null;
}

async function findCollectionByHandle(
  admin: AdminApiContext,
  handle: string,
): Promise<{ gid: string; handle: string } | null> {
  const response: Response = await graphqlWithRetry(admin,
    `#graphql
    query FindCollection($handle: String!) {
      collectionByHandle(handle: $handle) {
        id
        handle
        ruleSet { rules { column } }
      }
    }`,
    { variables: { handle } },
  );
  const json: any = await response.json();
  const collection = json.data?.collectionByHandle;
  if (!collection) return null;
  if (collection.ruleSet?.rules?.length > 0) return null;
  return { gid: collection.id, handle: collection.handle };
}

async function getExistingProductIds(
  admin: AdminApiContext,
  collectionGid: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response: Response = await graphqlWithRetry(admin,
      `#graphql
      query CollectionProducts($id: ID!, $after: String) {
        collection(id: $id) {
          products(first: 250, after: $after) {
            edges { node { id } cursor }
            pageInfo { hasNextPage }
          }
        }
      }`,
      { variables: { id: collectionGid, after: cursor } },
    );
    const json: any = await response.json();
    const products = json.data?.collection?.products;
    if (!products) break;
    for (const edge of products.edges) {
      ids.add(edge.node.id);
    }
    hasNextPage = products.pageInfo.hasNextPage;
    if (products.edges.length > 0) {
      cursor = products.edges[products.edges.length - 1].cursor;
    } else {
      hasNextPage = false;
    }
  }

  return ids;
}

async function addProductsToCollection(
  admin: AdminApiContext,
  collectionGid: string,
  productGids: string[],
) {
  const existing = await getExistingProductIds(admin, collectionGid);
  const newProducts = productGids.filter((gid) => !existing.has(gid));

  if (newProducts.length === 0) return;

  const batchSize = 250;
  for (let i = 0; i < newProducts.length; i += batchSize) {
    const batch = newProducts.slice(i, i + batchSize);
    const response: Response = await graphqlWithRetry(admin,
      `#graphql
      mutation AddProducts($id: ID!, $productIds: [ID!]!) {
        collectionAddProducts(id: $id, productIds: $productIds) {
          collection { id }
          userErrors { field message }
        }
      }`,
      {
        variables: { id: collectionGid, productIds: batch },
      },
    );
    const json: any = await response.json();
    const errors = json.data?.collectionAddProducts?.userErrors;
    if (errors?.length) {
      console.error("Failed to add products to collection:", errors);
    }
  }
}

async function processTreeLevel(
  admin: AdminApiContext,
  shopId: string,
  nodes: Map<string, TreeNode>,
  parentDbId: string | null,
  parentHandle: string | undefined,
  parentTitle: string | undefined,
  minProductThreshold: number,
  allDbNodes: Map<string, string>,
  publicationIds: string[],
  treeType: TreeType,
): Promise<void> {
  for (const [, treeNode] of nodes) {
    const productCount = treeNode.productIds.size;

    const dbNode = await db.hierarchyNode.upsert({
      where: {
        shopId_level_value_parentId_treeType: {
          shopId,
          level: treeNode.level,
          value: treeNode.value,
          parentId: parentDbId ?? "",
          treeType,
        },
      },
      create: {
        shopId,
        level: treeNode.level,
        levelName: treeNode.levelName,
        value: treeNode.value,
        parentId: parentDbId ?? "",
        treeType,
        productCount,
        isActive: productCount >= minProductThreshold,
      },
      update: {
        productCount,
        isActive: productCount >= minProductThreshold,
        levelName: treeNode.levelName,
      },
    });

    if (productCount >= minProductThreshold) {
      const handle = generateCollectionHandle(
        treeNode.levelName,
        treeNode.value,
        parentHandle,
        treeType,
      );
      const title = generateCollectionTitle(treeNode.value, parentTitle);

      let collectionGid = dbNode.collectionGid;
      let collectionHandle = dbNode.collectionHandle;

      if (!collectionGid) {
        const result = await createShopifyCollection(
          admin,
          title,
          handle,
          publicationIds,
        );
        if (result) {
          collectionGid = result.gid;
          collectionHandle = result.handle;
          await db.hierarchyNode.update({
            where: { id: dbNode.id },
            data: { collectionGid, collectionHandle },
          });
        }
      }

      if (collectionGid) {
        await addProductsToCollection(
          admin,
          collectionGid,
          Array.from(treeNode.productIds),
        );

        // Set metafields on collection
        await setHierarchyLevel(admin, collectionGid, treeNode.levelName);

        // Set hierarchy_tree metafield (branded/unbranded/single)
        if (treeType !== "single") {
          await setHierarchyTree(admin, collectionGid, treeType);
        }

        // Set parent_collection metafield
        if (parentDbId) {
          const parentNode = await db.hierarchyNode.findUnique({
            where: { id: parentDbId },
          });
          if (parentNode?.collectionGid) {
            await setParentCollection(
              admin,
              collectionGid,
              parentNode.collectionGid,
            );
          }
        }

        allDbNodes.set(dbNode.id, collectionGid);
      }

      // Recurse into children
      await processTreeLevel(
        admin,
        shopId,
        treeNode.children,
        dbNode.id,
        collectionHandle ?? handle,
        title,
        minProductThreshold,
        allDbNodes,
        publicationIds,
        treeType,
      );
    } else if (dbNode.collectionGid) {
      await handleCollectionRemoval(admin, shopId, {
        id: dbNode.id,
        collectionGid: dbNode.collectionGid,
        collectionHandle: dbNode.collectionHandle,
        parentId: dbNode.parentId,
      });
    }
  }
}

/**
 * For a single tree type, look up the collection GIDs along a product's path
 * and return them for breadcrumb assignment.
 */
async function getCollectionGidsForPath(
  shopId: string,
  path: Array<{ level: number; levelName: string; value: string }>,
  treeType: TreeType,
): Promise<string[]> {
  const collectionGids: string[] = [];
  let parentId: string | null = null;

  for (const entry of path) {
    const node: { id: string; collectionGid: string | null } | null =
      await db.hierarchyNode.findFirst({
        where: {
          shopId,
          level: entry.level,
          value: entry.value,
          parentId: parentId ?? "",
          treeType,
          isActive: true,
        },
      });
    if (node?.collectionGid) {
      collectionGids.push(node.collectionGid);
      parentId = node.id;
    } else {
      break;
    }
  }

  return collectionGids;
}

export async function buildFullHierarchy(
  admin: AdminApiContext,
  shopDomain: string,
) {
  const shop = await db.shop.upsert({
    where: { shopDomain },
    create: { shopDomain },
    update: {},
  });

  const settings: ShopSettings = {
    id: shop.id,
    brandMode: shop.brandMode as BrandMode,
    defaultBreadcrumbTree: shop.defaultBreadcrumbTree,
    minProductThreshold: shop.minProductThreshold,
    artistEnabled: shop.artistEnabled,
    lineEnabled: shop.lineEnabled,
    collectionEnabled: shop.collectionEnabled,
  };

  await ensureMetafieldDefinitions(admin);

  const products = await fetchAllProducts(admin);
  const publicationIds = await getPublicationIds(admin);

  const treeTypes = getTreeTypes(settings.brandMode);
  const allDbNodes = new Map<string, string>();

  // Build each tree type
  for (const treeType of treeTypes) {
    const { root } = buildTree(products, settings, treeType);

    await processTreeLevel(
      admin,
      shop.id,
      root,
      null,
      undefined,
      undefined,
      settings.minProductThreshold,
      allDbNodes,
      publicationIds,
      treeType,
    );
  }

  // Update collection_children metafields for all parent nodes
  for (const treeType of treeTypes) {
    const parentNodes = await db.hierarchyNode.findMany({
      where: {
        shopId: shop.id,
        treeType,
        isActive: true,
        collectionGid: { not: null },
      },
    });

    for (const parentNode of parentNodes) {
      if (!parentNode.collectionGid) continue;
      const childNodes = await db.hierarchyNode.findMany({
        where: {
          parentId: parentNode.id,
          isActive: true,
          collectionGid: { not: null },
        },
        select: { collectionGid: true, collectionHandle: true, value: true, productCount: true },
      });
      if (childNodes.length > 0) {
        const childData = childNodes
          .filter((c: { collectionHandle: string | null }) => c.collectionHandle !== null)
          .map((c: { collectionHandle: string | null; value: string; productCount: number }) => ({
            handle: c.collectionHandle!,
            title: c.value,
            count: c.productCount,
          }));
        await setCollectionChildren(
          admin,
          parentNode.collectionGid,
          childData,
        );
      }
    }
  }

  // Set breadcrumb metafields on each product
  for (const product of products) {
    if (settings.brandMode === "both") {
      // Set branded breadcrumbs
      const brandedPath = getProductHierarchyPath(
        product,
        settings,
        "branded",
      );
      const brandedGids = await getCollectionGidsForPath(
        shop.id,
        brandedPath,
        "branded",
      );
      if (brandedGids.length > 0) {
        await setProductBreadcrumbs(admin, product.id, brandedGids);
      }

      // Set unbranded breadcrumbs
      const unbrandedPath = getProductHierarchyPath(
        product,
        settings,
        "unbranded",
      );
      const unbrandedGids = await getCollectionGidsForPath(
        shop.id,
        unbrandedPath,
        "unbranded",
      );
      if (unbrandedGids.length > 0) {
        await setProductUnbrandedBreadcrumbs(
          admin,
          product.id,
          unbrandedGids,
        );
      }
    } else {
      // Single tree — set branded breadcrumbs only
      const path = getProductHierarchyPath(product, settings, "single");
      const collectionGids = await getCollectionGidsForPath(
        shop.id,
        path,
        "single",
      );
      if (collectionGids.length > 0) {
        await setProductBreadcrumbs(admin, product.id, collectionGids);
      }
    }
  }

  // Clean up stale nodes: nodes in DB that are active with collections
  // but were NOT visited during this sync (not in allDbNodes)
  const activeNodes = await db.hierarchyNode.findMany({
    where: {
      shopId: shop.id,
      isActive: true,
      collectionGid: { not: null },
      level: { lt: 100 }, // exclude standalone collections
    },
  });

  for (const node of activeNodes) {
    if (!allDbNodes.has(node.id) && node.collectionGid) {
      console.log(`Removing stale collection: ${node.value} (level ${node.level}, tree ${node.treeType})`);
      await handleCollectionRemoval(admin, shop.id, {
        id: node.id,
        collectionGid: node.collectionGid,
        collectionHandle: node.collectionHandle,
        parentId: node.parentId,
      });
    }
  }

  // Mark last sync
  await db.shop.update({
    where: { id: shop.id },
    data: { lastSyncAt: new Date() },
  });

  return {
    totalProducts: products.length,
    totalNodes: allDbNodes.size,
  };
}
