import { describe, expect, it } from "vitest";
import { addressKey } from "../src/client-address.js";

describe("addressKey (L2)", () => {
  it("keeps IPv4, unwraps IPv4-mapped IPv6, and keys other IPv6 on the /64", () => {
    expect(addressKey("198.51.100.7")).toBe("198.51.100.7");
    expect(addressKey("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(addressKey("::ffff:c633:6407")).toBe("198.51.100.7");
    expect(addressKey("2001:4860:1:2::1")).toBe("2001:4860:1:2::/64");
    expect(addressKey("2001:4860:0001:0002:ffff:0:0:9")).toBe("2001:4860:1:2::/64");
    expect(addressKey("2001:4860::")).toBe("2001:4860:0:0::/64");
    expect(addressKey("::1")).toBe("0:0:0:0::/64");
    expect(addressKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(addressKey("unknown")).toBe("unknown");
  });
});
