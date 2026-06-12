import {
  getNetworkAddressFamily,
  isBlockedNetworkAddress,
  isBlockedNetworkHostname,
  normalizeNetworkHostname,
} from "@steipete/summarize-core/content";
import { describe, expect, it } from "vitest";

describe("network safety policy", () => {
  it("blocks local, private, multicast, and reserved network addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.0.1",
      "169.254.169.254",
      "198.51.100.1",
      "203.0.113.1",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:0:192.168.1.1",
      "::ffff:0:a9fe:a9fe",
      "::7f00:1",
      "64:ff9b::a9fe:a9fe",
      "64:ff9b:1::808:808",
      "100::1",
      "2001:2::1",
      "2002:ac10:1::1",
      "3fff::1",
      "5f00::1",
      "fc00::1",
      "fe80::1",
    ]) {
      expect(isBlockedNetworkAddress(address), address).toBe(true);
    }
  });

  it("allows public IPv4, IPv6, and NAT64 addresses", () => {
    for (const address of [
      "192.0.8.1",
      "8.8.8.8",
      "::ffff:0:8.8.8.8",
      "64:ff9b::808:808",
      "[2606:4700:4700::1111]",
    ]) {
      expect(isBlockedNetworkAddress(address), address).toBe(false);
    }
  });

  it("normalizes URL hostnames and blocks localhost names", () => {
    expect(normalizeNetworkHostname("[::1]")).toBe("::1");
    expect(getNetworkAddressFamily("8.8.8.8")).toBe(4);
    expect(getNetworkAddressFamily("[2606:4700:4700::1111]")).toBe(6);
    expect(getNetworkAddressFamily("example.com")).toBe(0);
    expect(isBlockedNetworkHostname("localhost")).toBe(true);
    expect(isBlockedNetworkHostname("feed.localhost.")).toBe(true);
    expect(isBlockedNetworkHostname("printer.local")).toBe(true);
    expect(isBlockedNetworkHostname("example.com")).toBe(false);
  });
});
