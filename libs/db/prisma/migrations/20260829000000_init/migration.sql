-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "handle" TEXT NOT NULL,
    "displayName" TEXT,
    "profile" TEXT,
    "points" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lat" REAL NOT NULL,
    "lng" REAL NOT NULL,
    "gridKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "passability" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "heightCm" INTEGER,
    "widthCm" INTEGER,
    "note" TEXT,
    "photoUrl" TEXT,
    "accuracyM" REAL,
    "capturedByProfile" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "transcript" TEXT,
    "parseConfidence" REAL,
    "reviewedAt" DATETIME,
    "reviewNote" TEXT,
    "clientReportId" TEXT,
    "agreeCount" INTEGER NOT NULL DEFAULT 0,
    "disagreeCount" INTEGER NOT NULL DEFAULT 0,
    "confidence" REAL NOT NULL DEFAULT 0.5,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "authorId" TEXT,
    "traceId" TEXT,
    "detectorConfidence" REAL,
    "surfaceScanId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Report_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Report_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "Trace" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Report_surfaceScanId_fkey" FOREIGN KEY ("surfaceScanId") REFERENCES "SurfaceScan" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SurfaceScan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientScanId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "quality" TEXT NOT NULL,
    "cadenceSpm" REAL NOT NULL DEFAULT 0,
    "findingCount" INTEGER NOT NULL DEFAULT 0,
    "reportCount" INTEGER NOT NULL DEFAULT 0,
    "uploadedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Vote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reportId" TEXT NOT NULL,
    "userId" TEXT,
    "agree" BOOLEAN NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Vote_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Vote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Trace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "path" TEXT NOT NULL,
    "distanceM" REAL NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    CONSTRAINT "Trace_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SensorLoggerUpload" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "studyId" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" TEXT,
    "claimedAt" DATETIME,
    "completedAt" DATETIME,
    "error" TEXT,
    "bytes" INTEGER,
    "findingCount" INTEGER,
    "reportCount" INTEGER,
    "quality" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CoverageCell" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cellKey" TEXT NOT NULL,
    "lat" REAL NOT NULL,
    "lng" REAL NOT NULL,
    "visits" INTEGER NOT NULL DEFAULT 1,
    "bestAccuracyM" REAL,
    "traceId" TEXT,
    "userId" TEXT,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL,
    CONSTRAINT "CoverageCell_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "Trace" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_handle_key" ON "User"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "Report_clientReportId_key" ON "Report"("clientReportId");

-- CreateIndex
CREATE INDEX "Report_lat_lng_idx" ON "Report"("lat", "lng");

-- CreateIndex
CREATE INDEX "Report_kind_idx" ON "Report"("kind");

-- CreateIndex
CREATE INDEX "Report_gridKey_idx" ON "Report"("gridKey");

-- CreateIndex
CREATE INDEX "Report_createdAt_idx" ON "Report"("createdAt");

-- CreateIndex
CREATE INDEX "Report_status_createdAt_idx" ON "Report"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Report_surfaceScanId_idx" ON "Report"("surfaceScanId");

-- CreateIndex
CREATE UNIQUE INDEX "SurfaceScan_clientScanId_key" ON "SurfaceScan"("clientScanId");

-- CreateIndex
CREATE INDEX "SurfaceScan_createdAt_idx" ON "SurfaceScan"("createdAt");

-- CreateIndex
CREATE INDEX "Vote_reportId_idx" ON "Vote"("reportId");

-- CreateIndex
CREATE UNIQUE INDEX "Vote_reportId_userId_key" ON "Vote"("reportId", "userId");

-- CreateIndex
CREATE INDEX "Trace_userId_idx" ON "Trace"("userId");

-- CreateIndex
CREATE INDEX "SensorLoggerUpload_status_receivedAt_idx" ON "SensorLoggerUpload"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SensorLoggerUpload_studyId_uploadId_key" ON "SensorLoggerUpload"("studyId", "uploadId");

-- CreateIndex
CREATE UNIQUE INDEX "CoverageCell_cellKey_key" ON "CoverageCell"("cellKey");

-- CreateIndex
CREATE INDEX "CoverageCell_lat_lng_idx" ON "CoverageCell"("lat", "lng");

-- CreateIndex
CREATE INDEX "CoverageCell_traceId_idx" ON "CoverageCell"("traceId");

