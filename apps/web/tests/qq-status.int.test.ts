import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/server/db";
import { getOptionalUser } from "../src/server/session";
import { GET } from "../src/app/api/connect/qq/status/route";

vi.mock("../src/server/session", () => ({ getOptionalUser: vi.fn() }));
const USER_A = "int-qq-status-a", USER_B = "int-qq-status-b", BOT = "3463802115";

beforeAll(async () => {
  vi.stubEnv("ONEBOT_SELF_ID", BOT);
  await prisma.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
  await prisma.user.createMany({ data: [
    { id: USER_A, email: "qq-status-a@int.test" },
    { id: USER_B, email: "qq-status-b@int.test" },
  ] });
  await prisma.channelBinding.create({ data: {
    userId: USER_A, channel: "QQ_ONEBOT", externalUserId: "12345678", bridgeSessionId: BOT, verifiedAt: new Date(), sessionState: "ACTIVE",
  } });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await prisma.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
  await prisma.$disconnect();
});

describe("QQ binding polling endpoint", () => {
  it("requires a session and marks the response private/no-store", async () => {
    vi.mocked(getOptionalUser).mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("returns only the authenticated user's binding", async () => {
    vi.mocked(getOptionalUser).mockResolvedValue({ id: USER_A, email: "a@int.test", name: null, timeZone: "Asia/Shanghai", role: "USER" });
    const own = await GET();
    expect(await own.json()).toEqual({ verified: true, qqNumber: "12345678" });
    vi.mocked(getOptionalUser).mockResolvedValue({ id: USER_B, email: "b@int.test", name: null, timeZone: "Asia/Shanghai", role: "USER" });
    const other = await GET();
    expect(await other.json()).toEqual({ verified: false });
    expect(other.headers.get("cache-control")).toBe("no-store");
  });
});
