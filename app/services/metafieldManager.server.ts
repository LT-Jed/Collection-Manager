import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { graphqlWithRetry } from "./graphqlWithRetry.server";

const METAFIELD_DEFINITIONS = [
  {
    ownerType: "COLLECTION",
    namespace: "custom",
    key: "children_data",
    type: "json",
    name: "Children Data",
  },
  {
    ownerType: "COLLECTION",
    namespace: "custom",
    key: "parent_collection",
    type: "collection_reference",
    name: "Parent Collection",
  },
  {
    ownerType: "COLLECTION",
    namespace: "custom",
    key: "hierarchy_level",
    type: "single_line_text_field",
    name: "Hierarchy Level",
  },
  {
    ownerType: "COLLECTION",
    namespace: "custom",
    key: "hierarchy_tree",
    type: "single_line_text_field",
    name: "Hierarchy Tree",
  },
  {
    ownerType: "PRODUCT",
    namespace: "custom",
    key: "breadcrumb_collections",
    type: "list.collection_reference",
    name: "Breadcrumb Collections",
  },
  {
    ownerType: "PRODUCT",
    namespace: "custom",
    key: "breadcrumb_unbranded",
    type: "list.collection_reference",
    name: "Breadcrumb Collections (Unbranded)",
  },
];

export async function ensureMetafieldDefinitions(
  admin: AdminApiContext,
) {
  for (const def of METAFIELD_DEFINITIONS) {
    const response: Response = await graphqlWithRetry(admin,
      `#graphql
      mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition { id }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          definition: {
            ownerType: def.ownerType,
            namespace: def.namespace,
            key: def.key,
            type: def.type,
            name: def.name,
          },
        },
      },
    );
    const json: any = await response.json();
    const errors = json.data?.metafieldDefinitionCreate?.userErrors;
    if (errors?.length) {
      // "already exists" is fine — skip it
      const alreadyExists = errors.some(
        (e: { message: string }) =>
          e.message.includes("already exists") ||
          e.message.includes("Namespace and key") ||
          e.message.includes("is in use"),
      );
      if (!alreadyExists) {
        console.error(
          `Failed to create metafield definition ${def.namespace}.${def.key}:`,
          errors,
        );
      }
    }
  }
}

async function setMetafields(
  admin: AdminApiContext,
  metafields: Array<{
    ownerId: string;
    namespace: string;
    key: string;
    type: string;
    value: string;
  }>,
  label: string,
) {
  const response: Response = await graphqlWithRetry(admin,
    `#graphql
    mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }`,
    { variables: { metafields } },
  );
  const json: any = await response.json();
  const errors = json.data?.metafieldsSet?.userErrors;
  if (errors?.length) {
    console.error(`Failed to set ${label} metafield:`, errors);
  }
}

export interface ChildCollectionData {
  handle: string;
  title: string;
  count: number;
}

export async function setCollectionChildren(
  admin: AdminApiContext,
  collectionGid: string,
  children: ChildCollectionData[],
) {
  await setMetafields(
    admin,
    [
      {
        ownerId: collectionGid,
        namespace: "custom",
        key: "children_data",
        type: "json",
        value: JSON.stringify(children),
      },
    ],
    "children_data",
  );
}

export async function setParentCollection(
  admin: AdminApiContext,
  collectionGid: string,
  parentCollectionGid: string,
) {
  await setMetafields(
    admin,
    [
      {
        ownerId: collectionGid,
        namespace: "custom",
        key: "parent_collection",
        type: "collection_reference",
        value: parentCollectionGid,
      },
    ],
    "parent_collection",
  );
}

export async function setHierarchyLevel(
  admin: AdminApiContext,
  collectionGid: string,
  levelName: string,
) {
  await setMetafields(
    admin,
    [
      {
        ownerId: collectionGid,
        namespace: "custom",
        key: "hierarchy_level",
        type: "single_line_text_field",
        value: levelName,
      },
    ],
    "hierarchy_level",
  );
}

export async function setHierarchyTree(
  admin: AdminApiContext,
  collectionGid: string,
  treeType: string,
) {
  await setMetafields(
    admin,
    [
      {
        ownerId: collectionGid,
        namespace: "custom",
        key: "hierarchy_tree",
        type: "single_line_text_field",
        value: treeType,
      },
    ],
    "hierarchy_tree",
  );
}

export async function setProductBreadcrumbs(
  admin: AdminApiContext,
  productGid: string,
  collectionGids: string[],
) {
  await setMetafields(
    admin,
    [
      {
        ownerId: productGid,
        namespace: "custom",
        key: "breadcrumb_collections",
        type: "list.collection_reference",
        value: JSON.stringify(collectionGids),
      },
    ],
    "breadcrumb_collections",
  );
}

export async function setProductUnbrandedBreadcrumbs(
  admin: AdminApiContext,
  productGid: string,
  collectionGids: string[],
) {
  await setMetafields(
    admin,
    [
      {
        ownerId: productGid,
        namespace: "custom",
        key: "breadcrumb_unbranded",
        type: "list.collection_reference",
        value: JSON.stringify(collectionGids),
      },
    ],
    "breadcrumb_unbranded",
  );
}

export async function syncAllParentMetafields(
  admin: AdminApiContext,
  nodes: Array<{
    collectionGid: string | null;
    collectionHandle: string | null;
    value: string;
    productCount: number;
    parentId: string | null;
    children: Array<{
      collectionGid: string | null;
      collectionHandle: string | null;
      value: string;
      productCount: number;
    }>;
  }>,
  nodeGidMap: Map<string, string>,
) {
  for (const node of nodes) {
    if (!node.collectionGid) continue;

    // Set children_data on this node (JSON array of {handle, title, count})
    const childData: ChildCollectionData[] = node.children
      .filter((c) => c.collectionHandle !== null)
      .map((c) => ({
        handle: c.collectionHandle!,
        title: c.value,
        count: c.productCount,
      }));
    if (childData.length > 0) {
      await setCollectionChildren(admin, node.collectionGid, childData);
    }

    // Set parent_collection on this node
    if (node.parentId) {
      const parentGid = nodeGidMap.get(node.parentId);
      if (parentGid) {
        await setParentCollection(admin, node.collectionGid, parentGid);
      }
    }
  }
}
