import { test as base } from "@playwright/test";
import {
  assertNoErrors,
  closeExtension,
  getBrowserFromProject,
  launchExtension,
  type ExtensionHarness,
} from "./extension-harness";
import { allowFirefoxExtensionTests } from "./extension-test-config";

export const test = base.extend<{ harness: ExtensionHarness }>({
  harness: async ({ browserName }, use, testInfo) => {
    testInfo.skip(
      browserName === "firefox" && !allowFirefoxExtensionTests,
      "Firefox extension tests require ALLOW_FIREFOX_EXTENSION_TESTS=1.",
    );
    const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));
    try {
      await use(harness);
      assertNoErrors(harness);
    } finally {
      await closeExtension(harness.context, harness.userDataDir);
    }
  },
});
