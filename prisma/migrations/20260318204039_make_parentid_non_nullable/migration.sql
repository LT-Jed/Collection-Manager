-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_HierarchyNode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "levelName" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "parentId" TEXT NOT NULL DEFAULT '',
    "collectionGid" TEXT,
    "collectionHandle" TEXT,
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "HierarchyNode_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_HierarchyNode" ("collectionGid", "collectionHandle", "createdAt", "id", "isActive", "level", "levelName", "parentId", "productCount", "shopId", "updatedAt", "value") SELECT "collectionGid", "collectionHandle", "createdAt", "id", "isActive", "level", "levelName", coalesce("parentId", '') AS "parentId", "productCount", "shopId", "updatedAt", "value" FROM "HierarchyNode";
DROP TABLE "HierarchyNode";
ALTER TABLE "new_HierarchyNode" RENAME TO "HierarchyNode";
CREATE INDEX "HierarchyNode_shopId_level_idx" ON "HierarchyNode"("shopId", "level");
CREATE INDEX "HierarchyNode_parentId_idx" ON "HierarchyNode"("parentId");
CREATE UNIQUE INDEX "HierarchyNode_shopId_level_value_parentId_key" ON "HierarchyNode"("shopId", "level", "value", "parentId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
