import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { graphqlWithRetry } from "./graphqlWithRetry.server";
import db from "../db.server";
import {
  getProductHierarchyPath,
  getTreeTypes,
  generateCollectionHandle,
  generateCollectionTitle,
  type ShopSettings,
} from "./hierarchyBuilder.server";
import {
  SEPARATE_COLLECTION_TYPES,
  resolveMetaobjectDisplayNames,
  createCollectionIfNeeded,
} from "./separateCollections.server";
import {
  setHierarchyLevel,
  setHierarchyTree,
  setParentCollection,
  setCollectionChildren,
  setProductBreadcrumbs,
  setProductUnbrandedBreadcrumbs,
} from "./metafieldManager.server";
import { handleCollectionRemoval } from "./redirectManager.server";

export interface ProductInput {
  id: string;
  status: string;
  vendor: string;
  productType: string;
  metafields: Map<string, string>;
}

/**
 * A node the product should belong to, with everything needed to create its
 * collection on demand. `threshold` is the minimum member count required for
 * the collection to exist (hierarchy uses the shop setting, standalone uses 1).
 */
interface NodeSpec {
  level: number;
  levelName: string;
  value: string;
  threshold: number;
  title: string;
  handle: string;
  templateSuffix?: string;
  setTreeMetafield: boolean;
}

interface DesiredChain {
  treeType: string;
  isStandalone: boolean;
  nodes: NodeSpec[];
}

const METAOBJECT_PREFIX = "gid://shopify/Metaobject/";

// ---------------------------------------------------------------------------
// Shopify collection membership helpers (batched)
// ---------------------------------------------------------------------------

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
  await graphqlWithRetry(admin,
    `#graphql
    mutation RemoveProducts($id: ID!, $productIds: [ID!]!) {
      collectionRemoveProducts(id: $id, productIds: $productIds) {
        userErrors { field message }
      }
    }`,
    { variables: { id: collectionGid, productIds: productGids } },
  );
}

// ---------------------------------------------------------------------------
// Count + children_data helpers (counts come straight from the membership table)
// ---------------------------------------------------------------------------

async function recomputeNodeCounts(
  nodeId: string,
): Promise<{ productCount: number; activeProductCount: number }> {
  const productCount = await db.nodeMembership.count({ where: { nodeId } });
  const activeProductCount = await db.nodeMembership.count({
    where: { nodeId, active: true },
  });
  await db.hierarchyNode.update({
    where: { id: nodeId },
    data: { productCount, activeProductCount },
  });
  return { productCount, activeProductCount };
}

async function getNodeMemberProductGids(nodeId: string): Promise<string[]> {
  const rows = await db.nodeMembership.findMany({
    where: { nodeId },
    select: { productGid: true },
  });
  return rows.map((r) => r.productGid);
}

/**
 * Rebuild a parent collection's children_data metafield from its active child
 * nodes, using each child's activeProductCount as the displayed count.
 */
async function setParentChildrenData(
  admin: AdminApiContext,
  shopId: string,
  parentId: string,
) {
  const parentNode = await db.hierarchyNode.findUnique({
    where: { id: parentId },
  });
  if (!parentNode?.collectionGid) return;
  const children = await db.hierarchyNode.findMany({
    where: {
      shopId,
      parentId,
      isActive: true,
      collectionHandle: { not: null },
    },
    select: { collectionHandle: true, value: true, activeProductCount: true },
  });
  await setCollectionChildren(
    admin,
    parentNode.collectionGid,
    children
      .filter((c) => c.collectionHandle !== null)
      .map((c) => ({
        handle: c.collectionHandle!,
        title: c.value,
        count: c.activeProductCount,
      })),
  );
}

// ---------------------------------------------------------------------------
// Desired-membership computation
// ---------------------------------------------------------------------------

function buildHierarchyChains(
  product: ProductInput,
  settings: ShopSettings,
): DesiredChain[] {
  const chains: DesiredChain[] = [];
  for (const treeType of getTreeTypes(settings.brandMode)) {
    const path = getProductHierarchyPath(product, settings, treeType);
    if (path.length === 0) continue;

    const nodes: NodeSpec[] = [];
    let parentHandle: string | undefined;
    let parentTitle: string | undefined;
    for (const entry of path) {
      const handle = generateCollectionHandle(
        entry.levelName,
        entry.value,
        parentHandle,
        treeType,
      );
      const title = generateCollectionTitle(entry.value, parentTitle);
      nodes.push({
        level: entry.level,
        levelName: entry.levelName,
        value: entry.value,
        threshold: settings.minProductThreshold,
        title,
        handle,
        setTreeMetafield: treeType !== "single",
      });
      parentHandle = handle;
      parentTitle = title;
    }
    chains.push({ treeType, isStandalone: false, nodes });
  }
  return chains;
}

async function buildStandaloneChains(
  admin: AdminApiContext,
  product: ProductInput,
  settings: ShopSettings,
): Promise<DesiredChain[]> {
  const enabledByKey: Record<string, boolean> = {
    artist: settings.artistEnabled,
    line: settings.lineEnabled,
    collection: settings.collectionEnabled,
  };
  const enabledTypes = SEPARATE_COLLECTION_TYPES.filter(
    (t) => enabledByKey[t.key],
  );
  if (enabledTypes.length === 0) return [];

  // Resolve any metaobject-reference values to their display names, matching
  // how the full separate-collection sync derives collection titles.
  const rawByKey = new Map<string, string>();
  const metaobjectGids: string[] = [];
  for (const t of enabledTypes) {
    const raw = product.metafields.get(t.metafieldKey);
    if (raw && raw.trim()) {
      const trimmed = raw.trim();
      rawByKey.set(t.key, trimmed);
      if (trimmed.startsWith(METAOBJECT_PREFIX)) metaobjectGids.push(trimmed);
    }
  }
  const displayNames =
    metaobjectGids.length > 0
      ? await resolveMetaobjectDisplayNames(admin, metaobjectGids)
      : new Map<string, string>();

  const chains: DesiredChain[] = [];
  for (const t of enabledTypes) {
    const raw = rawByKey.get(t.key);
    if (!raw) continue;
    const value = displayNames.get(raw) ?? raw;
    const slug = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    chains.push({
      treeType: "single",
      isStandalone: true,
      nodes: [
        {
          level: 100,
          levelName: "Standalone",
          value: t.pluralLabel,
          threshold: 1,
          title: t.pluralLabel,
          handle: `${t.key}-all`,
          templateSuffix: "ParentCollection",
          setTreeMetafield: false,
        },
        {
          level: 101,
          levelName: t.label,
          value,
          threshold: 1,
          title: `${t.pluralLabel} > ${value}`,
          handle: `${t.key}-${slug}`,
          setTreeMetafield: false,
        },
      ],
    });
  }
  return chains;
}

// ---------------------------------------------------------------------------
// Per-node reconciliation
// ---------------------------------------------------------------------------

/**
 * Reconcile a single desired node: recompute its counts from the membership
 * table, create its collection (backfilling all members) when the threshold is
 * met, add the current product, or tear the collection down when it drops below
 * threshold. Returns the node's resulting collection GID (null when none).
 */
async function reconcileDesiredNode(
  admin: AdminApiContext,
  shopId: string,
  nodeId: string,
  spec: NodeSpec,
  treeType: string,
  productGid: string,
  parentCollectionGid: string | null,
): Promise<string | null> {
  const counts = await recomputeNodeCounts(nodeId);
  const node = await db.hierarchyNode.findUnique({ where: { id: nodeId } });
  if (!node) return null;

  if (counts.productCount < spec.threshold) {
    if (node.collectionGid) {
      await handleCollectionRemoval(admin, shopId, {
        id: node.id,
        collectionGid: node.collectionGid,
        collectionHandle: node.collectionHandle,
        parentId: node.parentId,
      });
    }
    return null;
  }

  let collectionGid = node.collectionGid;
  let justCreated = false;
  if (!collectionGid) {
    const result = await createCollectionIfNeeded(
      admin,
      spec.title,
      spec.handle,
      spec.templateSuffix,
    );
    if (!result) return null;
    collectionGid = result.gid;
    justCreated = true;
    await db.hierarchyNode.update({
      where: { id: nodeId },
      data: {
        collectionGid: result.gid,
        collectionHandle: result.handle,
        isActive: true,
      },
    });
    await setHierarchyLevel(admin, collectionGid, spec.levelName);
    if (spec.setTreeMetafield) {
      await setHierarchyTree(admin, collectionGid, treeType);
    }
    if (parentCollectionGid) {
      await setParentCollection(admin, collectionGid, parentCollectionGid);
    }
  } else if (!node.isActive) {
    await db.hierarchyNode.update({
      where: { id: nodeId },
      data: { isActive: true },
    });
  }

  if (justCreated) {
    // Backfill every product already recorded as a member — this is what lets a
    // newly-created collection be complete without a full sync.
    await addProductsToCollection(
      admin,
      collectionGid,
      await getNodeMemberProductGids(nodeId),
    );
  } else {
    await addProductsToCollection(admin, collectionGid, [productGid]);
  }

  return collectionGid;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Reconcile all of a product's collection memberships (hierarchy + standalone)
 * from a single product webhook. Records membership in the DB, manages the
 * underlying Shopify collections (create/backfill/add/remove/cleanup), keeps
 * counts exact, and refreshes children_data — so a full sync is never required
 * for ongoing product changes.
 */
export async function reconcileProductMembership(
  admin: AdminApiContext,
  shopId: string,
  settings: ShopSettings,
  productGid: string,
  product: ProductInput | null,
  eventType: "create" | "update" | "delete",
): Promise<void> {
  const isActive = product?.status === "ACTIVE";
  const chains =
    eventType === "delete" || !product
      ? []
      : [
          ...buildHierarchyChains(product, settings),
          ...(await buildStandaloneChains(admin, product, settings)),
        ];

  // 1. Resolve/create the desired nodes (root -> leaf so parentId links up).
  interface ResolvedNode {
    id: string;
    spec: NodeSpec;
    parentId: string;
  }
  const desiredNodeIds = new Set<string>();
  const resolvedChains: {
    treeType: string;
    isStandalone: boolean;
    nodes: ResolvedNode[];
  }[] = [];

  for (const chain of chains) {
    let parentId = "";
    const resolvedNodes: ResolvedNode[] = [];
    for (const spec of chain.nodes) {
      const dbNode = await db.hierarchyNode.upsert({
        where: {
          shopId_level_value_parentId_treeType: {
            shopId,
            level: spec.level,
            value: spec.value,
            parentId,
            treeType: chain.treeType,
          },
        },
        create: {
          shopId,
          level: spec.level,
          levelName: spec.levelName,
          value: spec.value,
          parentId,
          treeType: chain.treeType,
          productCount: 0,
          activeProductCount: 0,
          isActive: false,
        },
        update: { levelName: spec.levelName },
      });
      desiredNodeIds.add(dbNode.id);
      resolvedNodes.push({ id: dbNode.id, spec, parentId });
      parentId = dbNode.id;
    }
    resolvedChains.push({
      treeType: chain.treeType,
      isStandalone: chain.isStandalone,
      nodes: resolvedNodes,
    });
  }

  // 2. Reconcile the membership table for this product.
  const existing = await db.nodeMembership.findMany({
    where: { shopId, productGid },
    select: { nodeId: true },
  });
  const existingNodeIds = new Set(existing.map((e) => e.nodeId));

  for (const nodeId of desiredNodeIds) {
    await db.nodeMembership.upsert({
      where: { nodeId_productGid: { nodeId, productGid } },
      create: { shopId, nodeId, productGid, active: isActive },
      update: { active: isActive },
    });
  }
  const staleNodeIds = [...existingNodeIds].filter(
    (id) => !desiredNodeIds.has(id),
  );
  if (staleNodeIds.length > 0) {
    await db.nodeMembership.deleteMany({
      where: { productGid, nodeId: { in: staleNodeIds } },
    });
  }

  const parentsToRefresh = new Set<string>();

  // 3. Reconcile desired nodes (parent before child) and set breadcrumbs.
  for (const chain of resolvedChains) {
    let parentCollectionGid: string | null = null;
    const breadcrumbGids: string[] = [];
    for (const rn of chain.nodes) {
      const collectionGid = await reconcileDesiredNode(
        admin,
        shopId,
        rn.id,
        rn.spec,
        chain.treeType,
        productGid,
        parentCollectionGid,
      );
      parentCollectionGid = collectionGid;
      if (collectionGid) breadcrumbGids.push(collectionGid);
      if (rn.parentId) parentsToRefresh.add(rn.parentId);
    }

    if (!chain.isStandalone && product && breadcrumbGids.length > 0) {
      if (chain.treeType === "unbranded") {
        await setProductUnbrandedBreadcrumbs(admin, productGid, breadcrumbGids);
      } else {
        await setProductBreadcrumbs(admin, productGid, breadcrumbGids);
      }
    }
  }

  // 4. Reconcile nodes the product no longer belongs to.
  for (const nodeId of staleNodeIds) {
    const node = await db.hierarchyNode.findUnique({ where: { id: nodeId } });
    if (!node) continue;
    const counts = await recomputeNodeCounts(nodeId);
    const threshold = node.level >= 100 ? 1 : settings.minProductThreshold;
    if (node.collectionGid) {
      await removeProductsFromCollection(admin, node.collectionGid, [
        productGid,
      ]);
      if (counts.productCount < threshold) {
        await handleCollectionRemoval(admin, shopId, {
          id: node.id,
          collectionGid: node.collectionGid,
          collectionHandle: node.collectionHandle,
          parentId: node.parentId,
        });
      }
    }
    if (node.parentId) parentsToRefresh.add(node.parentId);
  }

  // 5. Refresh children_data on every affected parent so counts/links are current.
  for (const parentId of parentsToRefresh) {
    await setParentChildrenData(admin, shopId, parentId);
  }
}
