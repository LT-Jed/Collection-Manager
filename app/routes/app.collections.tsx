import { useState, useCallback } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { runFullSync } from "../services/collectionSync.server";

interface CollectionNode {
  id: string;
  level: number;
  levelName: string;
  value: string;
  productCount: number;
  collectionHandle: string | null;
  collectionGid: string | null;
  isActive: boolean;
  treeType: string;
  children: CollectionNode[];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await db.shop.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!shop) {
    return {
      tree: [] as CollectionNode[],
      standaloneTree: [] as CollectionNode[],
      shopDomain: session.shop,
      brandMode: "brand_only",
      isDualMode: false,
    };
  }

  const allNodes = await db.hierarchyNode.findMany({
    where: { shopId: shop.id, isActive: true },
    orderBy: [{ level: "asc" }, { value: "asc" }],
  });

  const hierarchyNodes = allNodes.filter((n) => n.level < 100);
  const standaloneNodes = allNodes.filter((n) => n.level >= 100);

  function buildTreeFrom(
    nodes: typeof allNodes,
    rootParentId: string,
  ): CollectionNode[] {
    const nodeMap = new Map<string, typeof nodes>();
    for (const node of nodes) {
      const parentId = node.parentId || "";
      if (!nodeMap.has(parentId)) nodeMap.set(parentId, []);
      nodeMap.get(parentId)!.push(node);
    }

    function buildTree(parentId: string): CollectionNode[] {
      const children = nodeMap.get(parentId) ?? [];
      return children.map((node) => ({
        id: node.id,
        level: node.level,
        levelName: node.levelName,
        value: node.value,
        productCount: node.productCount,
        collectionHandle: node.collectionHandle,
        collectionGid: node.collectionGid,
        isActive: node.isActive,
        treeType: node.treeType,
        children: buildTree(node.id),
      }));
    }

    return buildTree(rootParentId);
  }

  const hasBrandedNodes = hierarchyNodes.some(
    (n) => n.treeType === "branded",
  );
  const hasUnbrandedNodes = hierarchyNodes.some(
    (n) => n.treeType === "unbranded",
  );

  return {
    tree: buildTreeFrom(hierarchyNodes, ""),
    standaloneTree: buildTreeFrom(standaloneNodes, ""),
    shopDomain: session.shop,
    brandMode: shop.brandMode,
    isDualMode: hasBrandedNodes && hasUnbrandedNodes,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const nodeId = formData.get("nodeId") as string;

  if (!nodeId) return { success: false };

  await runFullSync(admin, session.shop);

  return { success: true };
};

function filterTreeByType(
  nodes: CollectionNode[],
  treeType: string,
): CollectionNode[] {
  return nodes
    .filter((n) => n.treeType === treeType)
    .map((n) => ({
      ...n,
      children: filterTreeByType(n.children, treeType),
    }));
}

function CollectionTreeNode({
  node,
  depth = 0,
  shopDomain,
}: {
  node: CollectionNode;
  depth?: number;
  shopDomain: string;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const fetcher = useFetcher();
  const isResyncing = fetcher.state !== "idle";

  const handleResync = useCallback(() => {
    fetcher.submit({ nodeId: node.id }, { method: "POST" });
  }, [fetcher, node.id]);

  const adminUrl = node.collectionGid
    ? `shopify:admin/collections/${node.collectionGid.split("/").pop()}`
    : null;

  return (
    <div style={{ marginLeft: depth > 0 ? "24px" : "0", marginTop: "4px" }}>
      <s-box padding="small-200" borderWidth="base" borderRadius="base">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          {node.children.length > 0 && (
            <s-button
              variant="tertiary"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "▼" : "▶"}
            </s-button>
          )}
          {node.children.length === 0 && (
            <span style={{ width: "28px", display: "inline-block" }} />
          )}

          <s-stack direction="block" gap="small-100">
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text type="strong">{node.value}</s-text>
              <s-badge tone="info">{node.levelName}</s-badge>
              <s-text color="subdued">
                {node.productCount} product
                {node.productCount !== 1 ? "s" : ""}
              </s-text>
              {node.children.length > 0 && (
                <s-text color="subdued">
                  · {node.children.length} subcollection
                  {node.children.length !== 1 ? "s" : ""}
                </s-text>
              )}
            </s-stack>
            {node.collectionHandle && (
              <s-stack direction="inline" gap="small-200">
                <s-text color="subdued">
                  Handle: {node.collectionHandle}
                </s-text>
                {adminUrl && (
                  <s-link href={adminUrl} target="_blank">
                    View in Shopify
                  </s-link>
                )}
              </s-stack>
            )}
          </s-stack>

          <s-button
            variant="tertiary"
            onClick={handleResync}
            {...(isResyncing ? { loading: true } : {})}
          >
            Re-sync
          </s-button>
        </s-stack>
      </s-box>

      {expanded &&
        node.children.map((child) => (
          <CollectionTreeNode
            key={child.id}
            node={child}
            depth={depth + 1}
            shopDomain={shopDomain}
          />
        ))}
    </div>
  );
}

export default function Collections() {
  const { tree, standaloneTree, shopDomain, isDualMode } =
    useLoaderData<typeof loader>();
  const [viewingTree, setViewingTree] = useState<"branded" | "unbranded">(
    "branded",
  );

  const displayTree = isDualMode
    ? filterTreeByType(tree, viewingTree)
    : tree;

  return (
    <s-page heading="Collections">
      <s-section>
        {isDualMode && (
          <s-box paddingBlockEnd="base">
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text color="subdued">Viewing:</s-text>
              <s-button
                variant={viewingTree === "branded" ? "primary" : "tertiary"}
                onClick={() => setViewingTree("branded")}
              >
                Branded
              </s-button>
              <s-button
                variant={viewingTree === "unbranded" ? "primary" : "tertiary"}
                onClick={() => setViewingTree("unbranded")}
              >
                Brandless
              </s-button>
            </s-stack>
          </s-box>
        )}

        {displayTree.length > 0 ? (
          <s-stack direction="block" gap="small-200">
            {displayTree.map((node: CollectionNode) => (
              <CollectionTreeNode
                key={node.id}
                node={node}
                shopDomain={shopDomain}
              />
            ))}
          </s-stack>
        ) : (
          <s-box padding="base">
            <s-stack direction="block" gap="base">
              <s-text color="subdued">
                No collections have been created yet. Go to the Dashboard and
                click "Sync Now" to build your collection hierarchy.
              </s-text>
              <s-link href="/app">Go to Dashboard</s-link>
            </s-stack>
          </s-box>
        )}
      </s-section>

      {standaloneTree.length > 0 && (
        <s-section heading="Standalone Collections">
          <s-stack direction="block" gap="small-200">
            {standaloneTree.map((node: CollectionNode) => (
              <CollectionTreeNode
                key={node.id}
                node={node}
                shopDomain={shopDomain}
              />
            ))}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
