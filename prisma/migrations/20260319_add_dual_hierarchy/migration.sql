-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- Drop and recreate Shop with new columns
CREATE TABLE "new_Shop" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "brandMode" TEXT NOT NULL DEFAULT 'brand_only',
    "defaultBreadcrumbTree" TEXT NOT NULL DEFAULT 'branded',
    "minProductThreshold" INTEGER NOT NULL DEFAULT 1,
    "artistEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lineEnabled" BOOLEAN NOT NULL DEFAULT false,
    "collectionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Shop" ("id", "shopDomain", "minProductThreshold", "artistEnabled", "lineEnabled", "collectionEnabled", "lastSyncAt", "createdAt", "updatedAt")
    SELECT "id", "shopDomain", "minProductThreshold", "artistEnabled", "lineEnabled", "collectionEnabled", "lastSyncAt", "createdAt", "updatedAt" FROM "Shop";
DROP TABLE "Shop";
ALTER TABLE "new_Shop" RENAME TO "Shop";
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");

-- Drop and recreate HierarchyNode with treeType
CREATE TABLE "new_HierarchyNode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "levelName" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "parentId" TEXT NOT NULL DEFAULT '',
    "treeType" TEXT NOT NULL DEFAULT 'single',
    "collectionGid" TEXT,
    "collectionHandle" TEXT,
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "HierarchyNode_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_HierarchyNode" ("id", "shopId", "level", "levelName", "value", "parentId", "collectionGid", "collectionHandle", "productCount", "isActive", "createdAt", "updatedAt")
    SELECT "id", "shopId", "level", "levelName", "value", "parentId", "collectionGid", "collectionHandle", "productCount", "isActive", "createdAt", "updatedAt" FROM "HierarchyNode";
DROP TABLE "HierarchyNode";
ALTER TABLE "new_HierarchyNode" RENAME TO "HierarchyNode";
CREATE UNIQUE INDEX "HierarchyNode_shopId_level_value_parentId_treeType_key" ON "HierarchyNode"("shopId", "level", "value", "parentId", "treeType");
CREATE INDEX "HierarchyNode_shopId_level_idx" ON "HierarchyNode"("shopId", "level");
CREATE INDEX "HierarchyNode_parentId_idx" ON "HierarchyNode"("parentId");
CREATE INDEX "HierarchyNode_treeType_idx" ON "HierarchyNode"("treeType");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
