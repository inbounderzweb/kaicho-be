import { Request } from "express";

const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 60;

// Separate from adminDashboard/pagination.ts's parsePagination on purpose:
// the public storefront's default page size (24, per spec) and cap (60) are
// deliberately different from the admin panel's (10/100) — same clamping
// shape, different numbers for a different audience.
export function parsePublicPagination(req: Request) {
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(String(req.query.pageSize ?? String(DEFAULT_PAGE_SIZE)), 10) || DEFAULT_PAGE_SIZE)
  );
  return { page, pageSize };
}
