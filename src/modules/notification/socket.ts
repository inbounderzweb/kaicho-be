import type { Server as HttpServer } from "http";
import { Server as IOServer, type Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { verifyNotificationToken } from "./token";
import { env } from "../../config/env";
import { User } from "../../database/models";
import type { SessionPayload } from "../../common/middleware/requireAuth";

// Every admin dashboard tab that's open joins this one room — broadcasting a
// new order is then a single io.to(ADMIN_ROOM).emit(...), regardless of how
// many admins/tabs are currently connected.
const ADMIN_ROOM = "admin";

let io: IOServer | null = null;

// The session cookie is HttpOnly, so the browser can't attach it as a socket
// auth token — it rides along automatically on the handshake request instead
// (same as any other cookie-bearing request), and this is what pulls it back
// out. Mirrors cookie-parser's own unescaping; deliberately no extra
// dependency for something this small.
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return part.slice(idx + 1).trim();
    }
  }
  return undefined;
}

// Same checks as requireAuth + requireRole("admin") (see
// common/middleware/requireAuth.ts / requireRole.ts) — a socket connection is
// just another authenticated entry point into the app and must be gated the
// same way, not a lighter one.
async function authenticateAdminSocket(socket: Socket): Promise<boolean> {
  const ticket = socket.handshake.auth?.token;
  const token = typeof ticket === "string" ? ticket : readCookie(socket.handshake.headers.cookie, env.cookieName);
  if (!token) return false;

  let payload: SessionPayload;
  try {
    payload = typeof ticket === "string"
      ? verifyNotificationToken(token)
      : jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] }) as SessionPayload;
  } catch {
    return false;
  }

  const user = await User.findById(payload.sub).select("role tokenVersion isActive").lean();
  if (!user || !user.isActive || user.tokenVersion !== payload.tv || user.role !== "admin") {
    return false;
  }
  return true;
}

export function initSocket(httpServer: HttpServer): void {
  io = new IOServer(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin || env.frontendOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    const ok = await authenticateAdminSocket(socket).catch(() => false);
    if (!ok) {
      next(new Error("Not authenticated"));
      return;
    }
    next();
  });

  io.on("connection", (socket) => {
    socket.join(ADMIN_ROOM);
  });
}

export interface NewOrderNotificationPayload {
  orderId: string;
  orderNumber: string;
  customerName: string;
  amount: number;
  itemsCount: number;
  createdAt: string;
}

// A no-op (not a throw) when Socket.IO was never initialized or nobody is
// connected — an admin who's offline still sees the order next time they
// open the panel via the normal order list, per spec; this channel is purely
// the "someone's watching right now" fast path.
export function emitNewOrderNotification(payload: NewOrderNotificationPayload): void {
  io?.to(ADMIN_ROOM).emit("order:new", payload);
}
