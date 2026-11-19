import { describe, expect, it } from "vitest";
import { POST } from "./route";

describe("/api/tools/[tool]", () => {
  it("/api/tools/toString is 404 (no prototype keys)", async () => {
    const res = await POST(new Request("http://x/api/tools/toString", { method: "POST", body: "{}" }), { params: Promise.resolve({ tool: "toString" }) });
    expect(res.status).toBe(404);
  });
});
