import { Request } from "express";

export function parsePagination(req: Request) {
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? "10"), 10) || 10));
  return { page, pageSize };
}
