import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { graphqlWithRetry } from "./graphqlWithRetry.server";
import db from "../db.server";
import { getPublicationIds, publishCollectionToAllChannels } from "./hierarchyBuilder.server";
import { setParentCollection, setCollectionChildren } from "./metafieldManager.server";

const SEPARATE_COLLECTION_TYPES = [
  { key: "artist", metafieldKey: "artist_name", label: "Artist", pluralLabel: "Artists" },
  { key: "line", metafieldKey: "line", label: "Line", pluralLabel: "Lines" },
  { key: "collection", metafieldKey: "collection", label: "Collection", pluralLabel: "Collections" },
] as const;

interface SeparateCollectionSettings {
  artistEnabled: boolean;
  lineEnabled: boolean;
  collectionEnabled: boolean;
}

async function resolveMetaobjectDisplayNames(
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
  Array<{ id: string; metafields: Map<string, string> }>
> {
  const products: Array<{ id: string; metafields: Map<string, string> }> = [];
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
      products.push({ id: edge.node.id, metafields });
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

async function createCollectionIfNeeded(
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
        isActive: true,
      },
      update: {
        collectionGid: parentResult?.gid ?? null,
        collectionHandle: parentResult?.handle ?? null,
        isActive: true,
      },
    });

    // Group products by metafield value
    const groups = new Map<string, string[]>();
    for (const product of products) {
      const value = product.metafields.get(collType.metafieldKey);
      if (value && value.trim()) {
        const trimmed = value.trim();
        if (!groups.has(trimmed)) {
          groups.set(trimmed, []);
        }
        groups.get(trimmed)!.push(product.id);
      }
    }

    // Create a collection for each unique value
    const childGids: string[] = [];
    for (const [value, productIds] of groups) {
      const handle = `${collType.key}-${value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
      const title = `${parentTitle} > ${value}`;

      const result = await createCollectionIfNeeded(admin, title, handle);
      if (result) {
        childGids.push(result.gid);
        await addProductsToCollection(admin, result.gid, productIds);

        // Set parent_collection metafield on the child
        if (parentResult) {
          await setParentCollection(admin, result.gid, parentResult.gid);
        }

        // Upsert child node in DB (level 101 = standalone children)
        await db.hierarchyNode.upsert({
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
            isActive: true,
          },
          update: {
            collectionGid: result.gid,
            collectionHandle: result.handle,
            productCount: productIds.length,
            isActive: true,
          },
        });
      }
    }

    // Set collection_children metafield on the parent
    if (parentResult && childGids.length > 0) {
      await setCollectionChildren(admin, parentResult.gid, childGids);
    }

    // Update parent product count
    const totalProducts = Array.from(groups.values()).reduce((sum, ids) => sum + ids.length, 0);
    await db.hierarchyNode.update({
      where: { id: parentDbNode.id },
      data: { productCount: totalProducts },
    });
  }
}
