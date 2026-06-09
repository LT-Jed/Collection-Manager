import { useEffect, useState, useCallback } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate, unauthenticated } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import {
  startFullSyncJob,
  runFullSyncJob,
} from "../services/collectionSync.server";
import { HIERARCHY_LEVELS } from "../services/hierarchyBuilder.server";

interface SyncJob {
  id: string;
  status: string;
  phaseLabel: string | null;
  phaseNumber: number;
  phaseCount: number;
  processed: number;
  total: number;
  error: string | null;
  updatedAt: string;
}

interface HierarchyNodeWithChildren {
  id: string;
  level: number;
  levelName: string;
  value: string;
  productCount: number;
  collectionHandle: string | null;
  collectionGid: string | null;
  isActive: boolean;
  treeType: string;
  children: HierarchyNodeWithChildren[];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const shop = await db.shop.upsert({
    where: { shopDomain },
    create: { shopDomain },
    update: {},
  });

  // Fetch all active nodes
  const allNodes = await db.hierarchyNode.findMany({
    where: { shopId: shop.id, isActive: true },
    orderBy: [{ level: "asc" }, { value: "asc" }],
  });

  // Split into hierarchy (levels 1-7) and standalone (levels 100+)
  const hierarchyNodes = allNodes.filter((n) => n.level < 100);
  const standaloneNodes = allNodes.filter((n) => n.level >= 100);

  // Build hierarchy tree (include treeType)
  const nodeMap = new Map<string, typeof hierarchyNodes>();
  for (const node of hierarchyNodes) {
    const parentId = node.parentId || "";
    if (!nodeMap.has(parentId)) nodeMap.set(parentId, []);
    nodeMap.get(parentId)!.push(node);
  }

  function buildTree(parentId: string): HierarchyNodeWithChildren[] {
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

  const tree = buildTree("");

  // Build standalone tree
  const standaloneMap = new Map<string, typeof standaloneNodes>();
  for (const node of standaloneNodes) {
    const parentId = node.parentId || "";
    if (!standaloneMap.has(parentId)) standaloneMap.set(parentId, []);
    standaloneMap.get(parentId)!.push(node);
  }

  function buildStandaloneTree(parentId: string): HierarchyNodeWithChildren[] {
    const children = standaloneMap.get(parentId) ?? [];
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
      children: buildStandaloneTree(node.id),
    }));
  }

  const standaloneTree = buildStandaloneTree("");

  // Get stats
  const totalCollections = allNodes.filter((n) => n.collectionGid).length;

  // Get level counts
  const levelCounts: Record<string, number> = {};
  for (const levelDef of HIERARCHY_LEVELS) {
    levelCounts[levelDef.name] = hierarchyNodes.filter(
      (n) => n.level === levelDef.level,
    ).length;
  }

  // Last sync job
  const lastJob = await db.collectionSyncJob.findFirst({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
  });

  // Determine if dual mode
  const hasBrandedNodes = hierarchyNodes.some((n) => n.treeType === "branded");
  const hasUnbrandedNodes = hierarchyNodes.some((n) => n.treeType === "unbranded");
  const isDualMode = hasBrandedNodes && hasUnbrandedNodes;

  return {
    tree,
    standaloneTree,
    totalCollections,
    hierarchyNodeCount: hierarchyNodes.length,
    standaloneNodeCount: standaloneNodes.length,
    levelCounts,
    lastSync: lastJob
      ? {
          status: lastJob.status,
          createdAt: lastJob.createdAt.toISOString(),
          triggeredBy: lastJob.triggeredBy,
        }
      : null,
    shopDomain,
    brandMode: shop.brandMode,
    isDualMode,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  try {
    // Create the job, then run the sync in the background so this request
    // returns immediately. The page polls /app/sync-status for progress. The
    // admin token is offline, so it stays valid after the request completes.
    const jobId = await startFullSyncJob(session.shop);

    const getAdmin = async () => {
      const { admin } = await unauthenticated.admin(session.shop);
      return admin;
    };

    // Detached on purpose: do not await. runFullSyncJob marks the job
    // completed/failed; the .catch is just a safety net against unhandled
    // rejections.
    void runFullSyncJob(session.shop, jobId, getAdmin).catch((error) => {
      console.error("Background sync failed:", error);
    });

    return { started: true, jobId };
  } catch (error) {
    return {
      started: false,
      error: error instanceof Error ? error.message : "Sync failed to start",
    };
  }
};

function filterTreeByType(
  nodes: HierarchyNodeWithChildren[],
  treeType: string,
): HierarchyNodeWithChildren[] {
  return nodes
    .filter((n) => n.treeType === treeType)
    .map((n) => ({
      ...n,
      children: filterTreeByType(n.children, treeType),
    }));
}

function TreeNode({
  node,
  depth = 0,
}: {
  node: HierarchyNodeWithChildren;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(depth < 2);

  return (
    <div style={{ marginLeft: depth > 0 ? "20px" : "0" }}>
      <s-box padding="small-200" borderWidth="base" borderRadius="base">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          {node.children.length > 0 && (
            <s-button
              variant="tertiary"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "−" : "+"}
            </s-button>
          )}
          <s-text type="strong">{node.value}</s-text>
          <s-badge>{node.levelName}</s-badge>
          <s-text color="subdued">{node.productCount} products</s-text>
          {node.collectionGid && (
            <s-link
              href={`shopify:admin/collections/${node.collectionGid.split("/").pop()}`}
              target="_blank"
            >
              View
            </s-link>
          )}
        </s-stack>
      </s-box>
      {expanded && node.children.length > 0 && (
        <div style={{ marginTop: "4px" }}>
          {node.children.map((child) => (
            <TreeNode key={child.id} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const {
    tree,
    standaloneTree,
    totalCollections,
    hierarchyNodeCount,
    standaloneNodeCount,
    levelCounts,
    lastSync,
    isDualMode,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const statusFetcher = useFetcher<{ job: SyncJob | null }>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const [viewingTree, setViewingTree] = useState<"branded" | "unbranded">(
    "branded",
  );

  // A sync is "running" if one was already in flight when the page loaded, or
  // if we just started one. This drives polling and the progress bar.
  const [syncing, setSyncing] = useState(lastSync?.status === "running");

  const job = statusFetcher.data?.job ?? null;

  // When the action confirms the sync started (or fails to start), react.
  useEffect(() => {
    const data = fetcher.data as
      | { started?: boolean; error?: string }
      | undefined;
    if (!data) return;
    if (data.started) {
      setSyncing(true);
    } else if (data.error) {
      shopify.toast.show(`Could not start sync: ${data.error}`, {
        isError: true,
      });
    }
  }, [fetcher.data, shopify]);

  // Poll the lightweight status endpoint while a sync is running.
  useEffect(() => {
    if (!syncing) return;
    statusFetcher.load("/app/sync-status");
    const id = setInterval(
      () => statusFetcher.load("/app/sync-status"),
      1500,
    );
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncing]);

  // React to terminal job states: toast + refresh the dashboard data.
  useEffect(() => {
    if (!job) return;
    if (job.status === "completed") {
      setSyncing(false);
      shopify.toast.show("Sync completed successfully");
      revalidator.revalidate();
    } else if (job.status === "failed") {
      setSyncing(false);
      shopify.toast.show(
        `Sync failed${job.error ? `: ${job.error}` : ""}`,
        { isError: true },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status]);

  // Detect a stalled background sync (e.g. the server restarted mid-run): stop
  // polling if the job hasn't reported progress for a while.
  useEffect(() => {
    if (!syncing || !job || job.status !== "running") return;
    const age = Date.now() - new Date(job.updatedAt).getTime();
    if (age > 120000) {
      setSyncing(false);
      shopify.toast.show("Sync appears to have stalled — check the logs.", {
        isError: true,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.updatedAt, syncing]);

  const isLoading =
    (["loading", "submitting"].includes(fetcher.state) &&
      fetcher.formMethod === "POST") ||
    syncing;

  const triggerSync = useCallback(
    () => fetcher.submit({}, { method: "POST" }),
    [fetcher],
  );

  // Overall completion percentage across all phases.
  const percent =
    job && job.phaseCount > 0
      ? Math.min(
          100,
          Math.max(
            0,
            Math.round(
              (((job.phaseNumber - 1) +
                (job.total > 0 ? job.processed / job.total : 0)) /
                job.phaseCount) *
                100,
            ),
          ),
        )
      : 0;

  // Filter tree for dual mode
  const displayTree = isDualMode
    ? filterTreeByType(tree, viewingTree)
    : tree;

  return (
    <s-page heading="Collection Manager">
      <s-button
        slot="primary-action"
        onClick={triggerSync}
        {...(isLoading ? { loading: true } : {})}
      >
        Sync Now
      </s-button>

      {syncing && (
        <s-section heading="Sync in progress">
          <s-stack direction="block" gap="small-200">
            <s-text type="strong">
              {job && job.phaseNumber > 0
                ? `Phase ${job.phaseNumber} of ${job.phaseCount}: ${job.phaseLabel ?? ""}`
                : "Starting…"}
            </s-text>
            <div
              style={{
                width: "100%",
                height: "8px",
                background: "#e3e3e3",
                borderRadius: "4px",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${percent}%`,
                  height: "100%",
                  background: "#008060",
                  transition: "width 0.3s ease",
                }}
              />
            </div>
            <s-text color="subdued">
              {percent}%
              {job && job.total > 0
                ? ` · ${job.processed} / ${job.total}`
                : ""}
            </s-text>
          </s-stack>
        </s-section>
      )}

      <s-section heading="Overview">
        <s-stack direction="inline" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small-200">
              <s-text color="subdued">Collections</s-text>
              <s-text type="strong">{totalCollections}</s-text>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small-200">
              <s-text color="subdued">Hierarchy Nodes</s-text>
              <s-text type="strong">{hierarchyNodeCount}</s-text>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small-200">
              <s-text color="subdued">Standalone Nodes</s-text>
              <s-text type="strong">{standaloneNodeCount}</s-text>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small-200">
              <s-text color="subdued">Last Sync</s-text>
              {lastSync ? (
                <>
                  <s-text>
                    {new Date(lastSync.createdAt).toLocaleString()}
                  </s-text>
                  <s-badge
                    tone={
                      lastSync.status === "completed"
                        ? "success"
                        : lastSync.status === "failed"
                          ? "critical"
                          : "warning"
                    }
                  >
                    {lastSync.status}
                  </s-badge>
                </>
              ) : (
                <s-text color="subdued">Never synced</s-text>
              )}
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

      <s-section heading="Collections per Level">
        <s-stack direction="inline" gap="small-200">
          {Object.entries(levelCounts).map(([name, count]) => (
            <s-box
              key={name}
              padding="small-200"
              borderWidth="base"
              borderRadius="base"
            >
              <s-stack direction="block" gap="small-100">
                <s-text color="subdued">{name}</s-text>
                <s-text type="strong">{count as number}</s-text>
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      </s-section>

      <s-section heading="Hierarchy Tree">
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
            {displayTree.map((node: HierarchyNodeWithChildren) => (
              <TreeNode key={node.id} node={node} />
            ))}
          </s-stack>
        ) : (
          <s-box padding="base">
            <s-text color="subdued">
              No hierarchy data yet. Click "Sync Now" to scan your products and
              build the collection hierarchy.
            </s-text>
          </s-box>
        )}
      </s-section>

      {standaloneTree.length > 0 && (
        <s-section heading="Standalone Collections">
          <s-stack direction="block" gap="small-200">
            {standaloneTree.map((node: HierarchyNodeWithChildren) => (
              <TreeNode key={node.id} node={node} />
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
