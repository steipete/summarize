import { describe, expect, it } from "vitest";
import { isWindowsContainerEnvironment } from "../src/daemon/windows-container.js";

describe("daemon/windows-container", () => {
  it("defaults to desktop mode when no container markers are present", () => {
    expect(isWindowsContainerEnvironment({})).toBe(false);
  });

  it("supports explicit container mode override", () => {
    expect(
      isWindowsContainerEnvironment({
        SUMMARIZE_WINDOWS_CONTAINER_MODE: "container",
      }),
    ).toBe(true);
  });

  it("supports explicit desktop mode override", () => {
    expect(
      isWindowsContainerEnvironment({
        SUMMARIZE_WINDOWS_CONTAINER_MODE: "desktop",
        CONTAINER_SANDBOX_MOUNT_POINT: "C:\\ContainerMappedDirectories",
      }),
    ).toBe(false);
  });

  it("auto-detects common container environment markers", () => {
    expect(
      isWindowsContainerEnvironment({
        CONTAINER_SANDBOX_MOUNT_POINT: "C:\\ContainerMappedDirectories",
      }),
    ).toBe(true);
    expect(
      isWindowsContainerEnvironment({
        DOTNET_RUNNING_IN_CONTAINER: "true",
      }),
    ).toBe(true);
    expect(
      isWindowsContainerEnvironment({
        RUNNING_IN_CONTAINER: "1",
      }),
    ).toBe(true);
  });
});
