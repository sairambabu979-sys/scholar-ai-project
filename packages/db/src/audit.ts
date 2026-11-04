import { redact } from "@scholar/security";
import type { Prisma } from "./generated/prisma/client.ts";
import type { Db } from "./client.ts";

export interface AuditInput {
  userId: string;
  actor: "user" | "system" | "worker";
  action: string;
  targetType?: string;
  targetId?: string;
  /** Safe metadata only: IDs, counts, flags. Passed through redaction regardless. */
  metadata?: Record<string, unknown>;
  requestId?: string;
}

export async function recordAudit(
  db: Db | Prisma.TransactionClient,
  input: AuditInput,
): Promise<void> {
  await db.auditEvent.create({
    data: {
      userId: input.userId,
      actor: input.actor,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: (input.metadata ? redact(input.metadata) : undefined) as
        Prisma.InputJsonValue | undefined,
      requestId: input.requestId,
    },
  });
}
