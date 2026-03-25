import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { graphqlWithRetry } from "./graphqlWithRetry.server";
import db from "../db.server";

export async function createRedirect(
  admin: AdminApiContext,
  shopId: string,
  fromPath: string,
  toPath: string,
  reason: string,
) {
  const response: Response = await graphqlWithRetry(admin,
    `#graphql
    mutation CreateRedirect($urlRedirect: UrlRedirectInput!) {
      urlRedirectCreate(urlRedirect: $urlRedirect) {
        urlRedirect { id path target }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        urlRedirect: {
          path: fromPath,
          target: toPath,
        },
      },
    },
  );
  const json: any = await response.json();
  const errors = json.data?.urlRedirectCreate?.userErrors;
  if (errors?.length) {
    console.error("Failed to create redirect:", errors);
  }

  const redirectGid = json.data?.urlRedirectCreate?.urlRedirect?.id ?? null;

  await db.redirectLog.create({
    data: {
      shopId,
      fromPath,
      toPath,
      reason,
      redirectGid,
    },
  });

  return redirectGid;
}

export async function deleteCollection(
  admin: AdminApiContext,
  collectionGid: string,
) {
  const response: Response = await graphqlWithRetry(admin,
    `#graphql
    mutation DeleteCollection($input: CollectionDeleteInput!) {
      collectionDelete(input: $input) {
        deletedCollectionId
        userErrors { field message }
      }
    }`,
    {
      variables: {
        input: { id: collectionGid },
      },
    },
  );
  const json: any = await response.json();
  const errors = json.data?.collectionDelete?.userErrors;
  if (errors?.length) {
    console.error("Failed to delete collection:", errors);
  }
  return json.data?.collectionDelete?.deletedCollectionId ?? null;
}

export async function handleCollectionRemoval(
  admin: AdminApiContext,
  shopId: string,
  node: {
    id: string;
    collectionGid: string | null;
    collectionHandle: string | null;
    parentId: string | null;
  },
) {
  if (!node.collectionGid || !node.collectionHandle) return;

  // Determine redirect target
  let toPath = "/collections";
  if (node.parentId) {
    const parent = await db.hierarchyNode.findUnique({
      where: { id: node.parentId },
      select: { collectionHandle: true },
    });
    if (parent?.collectionHandle) {
      toPath = `/collections/${parent.collectionHandle}`;
    }
  }

  const fromPath = `/collections/${node.collectionHandle}`;

  // Create redirect in Shopify
  await createRedirect(
    admin,
    shopId,
    fromPath,
    toPath,
    "collection_removed_below_threshold",
  );

  // Delete the Shopify collection
  await deleteCollection(admin, node.collectionGid);

  // Mark node as inactive in DB
  await db.hierarchyNode.update({
    where: { id: node.id },
    data: {
      isActive: false,
      collectionGid: null,
      collectionHandle: null,
    },
  });
}
