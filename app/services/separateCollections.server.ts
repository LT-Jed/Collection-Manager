import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { graphqlWithRetry } from "./graphqlWithRetry.server";
import db from "../db.server";
import { getPublicationIds, publishCollectionToAllChannels } from "./hierarchyBuilder.server";
import { setParentCollection, setCollectionChildren } from "./metafieldManager.server";
import { handleCollectionRemoval } from "./redirectManager.server";

export const SEPARATE_COLLECTION_TYPES = [
  { key: "artist", metafieldKey: "artist_name", label: "Artist", pluralLabel: "Artists" },
  { key: "line", metafieldKey: "line", label: "Line", pluralLabel: "Lines" },
  { key: "collection", metafieldKey: "collection", label: "Collection", pluralLabel: "Collections" },
] as const;

interface SeparateCollectionSettings {
  artistEnabled: boolean;
  lineEnabled: boolean;
  collectionEnabled: boolean;
}

export async function resolveMetaobjectDisplayNames(
  admin: AdminApiContext,
  gids: string[],
): Promise<Map<string, string>> {
  const displayNames = new Map<string, string>();
  if (gids.length === 0) return displayNames;

  // Batch resolve in groups of 50
  for (let i = 0; i < gids.length; i += 50) {
    const batch = gids.slice(i, i + 50);
    const response: Response = await graphqlWithRetry(admin,
      `#graphql
      query ResolveMetaobjects($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Metaobject {
            id
            displayName
          }
        }
      }`,
      { variables: { ids: batch } },
    );
    const json: any = await response.json();
    const nodes = json.data?.nodes;
    if (nodes) {
      for (const node of nodes) {
        if (node?.id && node?.displayName) {
          displayNames.set(node.id, node.displayName);
        }
      }
    }
  }

  return displayNames;
}

async function fetchAllProductsWithMetafields(
  admin: AdminApiContext,
): Promise<
  Array<{ id: string; status: string; metafields: Map<string, string> }>
> {
  const products: Array<{ id: string; status: string; metafields: Map<string, string> }> = [];
  const metaobjectGids = new Set<string>();
  // Track which product metafields are metaobject references: [productIndex, key]
  const metaobjectRefs: Array<{ productIndex: number; key: string; gid: string }> = [];
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
              status
              metafields(first: 20, namespace: "custom") {
                edges { node { key value type } }
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
      const metafields = new Map<string, string>();
      const productIndex = products.length;
      for (const mfEdge of edge.node.metafields.edges) {
        const { key, value, type } = mfEdge.node;
        metafields.set(key, value);

        // Detect metaobject references
        if (type === "metaobject_reference" && value && value.startsWith("gid://")) {
          metaobjectGids.add(value);
          metaobjectRefs.push({ productIndex, key, gid: value });
        }
      }
      products.push({ id: edge.node.id, status: edge.node.status, metafields });
    }

    hasNextPage = data.pageInfo.hasNextPage;
    cursor = data.pageInfo.endCursor;
  }

  // Resolve metaobject GIDs to display names
  if (metaobjectGids.size > 0) {
    const displayNames = await resolveMetaobjectDisplayNames(admin, Array.from(metaobjectGids));
    for (const ref of metaobjectRefs) {
      const displayName = displayNames.get(ref.gid);
      if (displayName) {
        products[ref.productIndex].metafields.set(ref.key, displayName);
      }
    }
  }

  return products;
}

export async function createCollectionIfNeeded(
  admin: AdminApiContext,
  title: string,
  handle: string,
  templateSuffix?: string,
): Promise<{ gid: string; handle: string } | null> {
  const input: Record<string, string> = { title, handle };
  if (templateSuffix) input.templateSuffix = templateSuffix;

  const response: Response = await graphqlWithRetry(admin,
    `#graphql
    mutation CreateCollection($input: CollectionInput!) {
      collectionCreate(input: $input) {
        collection { id handle }
        userErrors { field message }
      }
    }`,
    { variables: { input } },
  );
  const json: any = await response.json();
  const errors = json.data?.collectionCreate?.userErrors;

  if (errors?.length) {
    if (errors.some((e: { message: string }) => e.message.includes("already"))) {
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
    console.error("Failed to create separate collection:", errors);
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

async function addProductsToCollection(
  admin: AdminApiContext,
  collectionGid: string,
  productGids: string[],
) {
  const batchSize = 250;
  for (let i = 0; i < productGids.length; i += batchSize) {
    const batch = productGids.slice(i, i + batchSize);
    await graphqlWithRetry(admin,
      `#graphql
      mutation AddProducts($id: ID!, $productIds: [ID!]!) {
        collectionAddProducts(id: $id, productIds: $productIds) {
          collection { id }
          userErrors { field message }
        }
      }`,
      { variables: { id: collectionGid, productIds: batch } },
    );
  }
}

async function removeProductsFromCollection(
  admin: AdminApiContext,
  collectionGid: string,
  productGids: string[],
) {
  const batchSize = 250;
  for (let i = 0; i < productGids.length; i += batchSize) {
    const batch = productGids.slice(i, i + batchSize);
    await graphqlWithRetry(admin,
      `#graphql
      mutation RemoveProducts($id: ID!, $productIds: [ID!]!) {
        collectionRemoveProducts(id: $id, productIds: $productIds) {
          userErrors { field message }
        }
      }`,
      { variables: { id: collectionGid, productIds: batch } },
    );
  }
}

async function fetchCollectionProductIds(
  admin: AdminApiContext,
  collectionGid: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response: Response = await graphqlWithRetry(admin,
      `#graphql
      query CollectionProducts($id: ID!, $cursor: String) {
        collection(id: $id) {
          products(first: 250, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            edges { node { id } }
          }
        }
      }`,
      { variables: { id: collectionGid, cursor } },
    );
    const json: any = await response.json();
    const data = json.data?.collection?.products;
    if (!data) break;

    for (const edge of data.edges) {
      ids.add(edge.node.id);
    }

    hasNextPage = data.pageInfo.hasNextPage;
    cursor = data.pageInfo.endCursor;
  }

  return ids;
}

// Reconcile a collection's membership to exactly match the desired product set:
// add the ones that are missing and remove stale products that no longer belong.
// Without the removal pass, collections built add-only accumulate stale products
// (whose metafield value changed or was cleared), so the storefront count badge
// — derived from the current grouping — ends up lower than the collection's
// actual product count.
async function reconcileCollectionProducts(
  admin: AdminApiContext,
  collectionGid: string,
  desiredProductIds: string[],
) {
  const desired = new Set(desiredProductIds);
  const existing = await fetchCollectionProductIds(admin, collectionGid);

  const toRemove = [...existing].filter((id) => !desired.has(id));
  const toAdd = desiredProductIds.filter((id) => !existing.has(id));

  if (toRemove.length > 0) {
    console.log(`Removing ${toRemove.length} stale products from collection`);
    await removeProductsFromCollection(admin, collectionGid, toRemove);
  }
  if (toAdd.length > 0) {
    await addProductsToCollection(admin, collectionGid, toAdd);
  }
}

export async function syncSeparateCollections(
  admin: AdminApiContext,
  shopDomain: string,
) {
  const shop = await db.shop.findUnique({ where: { shopDomain } });
  if (!shop) return;

  const settings: SeparateCollectionSettings = {
    artistEnabled: shop.artistEnabled,
    lineEnabled: shop.lineEnabled,
    collectionEnabled: shop.collectionEnabled,
  };

  const products = await fetchAllProductsWithMetafields(admin);
  const activeProductIds = new Set(
    products.filter((p) => p.status === "ACTIVE").map((p) => p.id),
  );

  // Authoritative rebuild of standalone membership: clear stale rows up front;
  // the per-node writes below repopulate every current standalone node.
  await db.nodeMembership.deleteMany({
    where: { shopId: shop.id, node: { level: { gte: 100 } } },
  });

  // Track visited nodes for stale cleanup
  const visitedParentKeys = new Set<string>();
  const visitedChildValues = new Map<string, Set<string>>();

  for (const collType of SEPARATE_COLLECTION_TYPES) {
    const settingKey = `${collType.key}Enabled` as keyof SeparateCollectionSettings;
    if (!settings[settingKey]) continue;

    // Create or find the parent "shop page" collection for this type
    const parentHandle = `${collType.key}-all`;
    const parentTitle = collType.pluralLabel;
    const parentResult = await createCollectionIfNeeded(admin, parentTitle, parentHandle, "ParentCollection");

    // Upsert parent node in DB (level 100 = standalone parents)
    const parentDbNode = await db.hierarchyNode.upsert({
      where: {
        shopId_level_value_parentId_treeType: {
          shopId: shop.id,
          level: 100,
          value: collType.pluralLabel,
          parentId: "",
          treeType: "single",
        },
      },
      create: {
        shopId: shop.id,
        level: 100,
        levelName: "Standalone",
        value: collType.pluralLabel,
        parentId: "",
        collectionGid: parentResult?.gid ?? null,
        collectionHandle: parentResult?.handle ?? null,
        productCount: 0,
        activeProductCount: 0,
        isActive: true,
      },
      update: {
        collectionGid: parentResult?.gid ?? null,
        collectionHandle: parentResult?.handle ?? null,
        isActive: true,
      },
    });

    // Group products by metafield value. All products are added to the
    // collection (membership), but only active products are counted toward the
    // number shown on the storefront.
    const groups = new Map<string, string[]>();
    const activeCounts = new Map<string, number>();
    for (const product of products) {
      const value = product.metafields.get(collType.metafieldKey);
      if (value && value.trim()) {
        const trimmed = value.trim();
        if (!groups.has(trimmed)) {
          groups.set(trimmed, []);
          activeCounts.set(trimmed, 0);
        }
        groups.get(trimmed)!.push(product.id);
        if (product.status === "ACTIVE") {
          activeCounts.set(trimmed, activeCounts.get(trimmed)! + 1);
        }
      }
    }

    // Reconcile the parent collection to exactly the products with this metafield
    // (adds new ones, removes stale ones that no longer match).
    const allProductIds = Array.from(groups.values()).flat();
    if (parentResult) {
      console.log(`Reconciling ${allProductIds.length} products on parent "${parentTitle}" collection`);
      await reconcileCollectionProducts(admin, parentResult.gid, allProductIds);
    }

    // Create a collection for each unique value
    const childData: Array<{ handle: string; title: string; count: number }> = [];
    console.log(`Creating ${groups.size} child collections for "${collType.key}"`);
    for (const [value, productIds] of groups) {
      const handle = `${collType.key}-${value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
      const title = `${parentTitle} > ${value}`;

      const activeCount = activeCounts.get(value) ?? 0;
      const result = await createCollectionIfNeeded(admin, title, handle);
      if (result) {
<<<<<<< HEAD
        childData.push({ handle: result.handle, title: value, count: productIds.length });
        await reconcileCollectionProducts(admin, result.gid, productIds);
=======
        childData.push({ handle: result.handle, title: value, count: activeCount });
        await addProductsToCollection(admin, result.gid, productIds);
>>>>>>> 659c0ef99c440ad581afe06cccc9185eaad400ef

        // Set parent_collection metafield on the child
        if (parentResult) {
          await setParentCollection(admin, result.gid, parentResult.gid);
        }

        // Upsert child node in DB (level 101 = standalone children)
        const childDbNode = await db.hierarchyNode.upsert({
          where: {
            shopId_level_value_parentId_treeType: {
              shopId: shop.id,
              level: 101,
              value,
              parentId: parentDbNode.id,
              treeType: "single",
            },
          },
          create: {
            shopId: shop.id,
            level: 101,
            levelName: collType.label,
            value,
            parentId: parentDbNode.id,
            collectionGid: result.gid,
            collectionHandle: result.handle,
            productCount: productIds.length,
            activeProductCount: activeCount,
            isActive: true,
          },
          update: {
            collectionGid: result.gid,
            collectionHandle: result.handle,
            productCount: productIds.length,
            activeProductCount: activeCount,
            isActive: true,
          },
        });

        // Record membership so the incremental sync can manage this collection.
        await db.nodeMembership.deleteMany({ where: { nodeId: childDbNode.id } });
        await db.nodeMembership.createMany({
          data: productIds.map((productGid) => ({
            shopId: shop.id,
            nodeId: childDbNode.id,
            productGid,
            active: activeProductIds.has(productGid),
          })),
        });
      }
    }

    // Set children_data metafield on the parent (JSON array of {handle, title, count})
    if (parentResult && childData.length > 0) {
      await setCollectionChildren(admin, parentResult.gid, childData);
    }

    // Update parent product count
    const totalProducts = Array.from(groups.values()).reduce((sum, ids) => sum + ids.length, 0);
    const activeTotal = Array.from(activeCounts.values()).reduce((sum, n) => sum + n, 0);
    await db.hierarchyNode.update({
      where: { id: parentDbNode.id },
      data: { productCount: totalProducts, activeProductCount: activeTotal },
    });

    // Record parent ("all") membership: every product carrying this metafield.
    await db.nodeMembership.deleteMany({ where: { nodeId: parentDbNode.id } });
    if (allProductIds.length > 0) {
      await db.nodeMembership.createMany({
        data: allProductIds.map((productGid) => ({
          shopId: shop.id,
          nodeId: parentDbNode.id,
          productGid,
          active: activeProductIds.has(productGid),
        })),
      });
    }

    // Track which child values we visited for cleanup
    visitedChildValues.set(collType.key, new Set(groups.keys()));
    visitedParentKeys.add(collType.key);
  }

  // Clean up stale standalone collections
  const allStandaloneNodes = await db.hierarchyNode.findMany({
    where: {
      shopId: shop.id,
      collectionGid: { not: null },
      level: { gte: 100 },
    },
  });

  for (const node of allStandaloneNodes) {
    if (!node.collectionGid) continue;

    if (node.level === 100) {
      // Parent node — check if the setting is still enabled
      const collType = SEPARATE_COLLECTION_TYPES.find(
        (ct) => ct.pluralLabel === node.value,
      );
      if (!collType || !visitedParentKeys.has(collType.key)) {
        console.log(`Removing stale standalone parent: ${node.value}`);
        await handleCollectionRemoval(admin, shop.id, {
          id: node.id,
          collectionGid: node.collectionGid,
          collectionHandle: node.collectionHandle,
          parentId: node.parentId,
        });
      }
    } else if (node.level === 101) {
      // Child node — check if parent still exists and this value was visited
      const parentNode = allStandaloneNodes.find(
        (n) => n.id === node.parentId && n.level === 100,
      );
      if (!parentNode) {
        // Parent gone, remove child
        console.log(`Removing orphaned standalone child: ${node.value}`);
        await handleCollectionRemoval(admin, shop.id, {
          id: node.id,
          collectionGid: node.collectionGid,
          collectionHandle: node.collectionHandle,
          parentId: node.parentId,
        });
        continue;
      }

      const collType = SEPARATE_COLLECTION_TYPES.find(
        (ct) => ct.pluralLabel === parentNode.value,
      );
      const visitedValues = collType
        ? visitedChildValues.get(collType.key)
        : undefined;
      if (!visitedValues || !visitedValues.has(node.value)) {
        console.log(`Removing stale standalone child: ${node.value} (under ${parentNode.value})`);
        await handleCollectionRemoval(admin, shop.id, {
          id: node.id,
          collectionGid: node.collectionGid,
          collectionHandle: node.collectionHandle,
          parentId: node.parentId,
        });
      }
    }
  }
}
