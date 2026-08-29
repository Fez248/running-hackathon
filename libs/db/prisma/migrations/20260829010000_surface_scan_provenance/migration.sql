-- Capture provenance on a surface scan: how the recording that produced the
-- findings was made. All nullable, because a payload from a bridge build that
-- predates the provenance block must still ingest.
ALTER TABLE "SurfaceScan" ADD COLUMN "recorderApp" TEXT;
ALTER TABLE "SurfaceScan" ADD COLUMN "recorderVersion" TEXT;
ALTER TABLE "SurfaceScan" ADD COLUMN "deviceModel" TEXT;
ALTER TABLE "SurfaceScan" ADD COLUMN "platform" TEXT;
ALTER TABLE "SurfaceScan" ADD COLUMN "requestedFsHz" REAL;
ALTER TABLE "SurfaceScan" ADD COLUMN "measuredFsHz" REAL;
ALTER TABLE "SurfaceScan" ADD COLUMN "unitScale" REAL;
ALTER TABLE "SurfaceScan" ADD COLUMN "detectorThreshold" REAL;
