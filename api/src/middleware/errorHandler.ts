// api/src/middleware/errorHandler.ts
// Last-resort error handler. Route handlers should catch and translate
// expected failures themselves (validation, not-found, permission) —
// this only exists to prevent an unexpected throw from crashing the
// process or leaking a stack trace to the client.

import type { Request, Response, NextFunction } from "express";
import { env } from "../env.ts";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  console.error(JSON.stringify({ level: "error", msg: "Unhandled API error", error: String(err) }));

  if (res.headersSent) return;

  res.status(500).json({
    error: "internal_server_error",
    detail: env.NODE_ENV === "development" ? String(err) : undefined,
  });
}
