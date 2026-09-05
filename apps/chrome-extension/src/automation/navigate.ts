import { listSkills } from "./skills-store";

export type NavigateArgs = {
  url?: string;
  newTab?: boolean;
  listTabs?: boolean;
  switchToTab?: number;
};

export type TabInfo = {
  id: number;
  url: string | null;
  title: string | null;
  active: boolean;
  windowId: number;
};

export type SkillInfo = {
  name: string;
  shortDescription: string;
};

export type NavigateResult = {
  finalUrl?: string | null;
  title?: string | null;
  tabId?: number;
  tabs?: TabInfo[];
  switchedToTab?: number;
  skills?: SkillInfo[];
};

async function waitForTabComplete(tabId: number, timeoutMs = 15_000): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Navigation timed out"));
    }, timeoutMs);

    const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status !== "complete") return;
      void chrome.tabs.get(tabId).then(
        (tab) => {
          cleanup();
          resolve(tab);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    };

    const cleanup = () => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

export async function executeNavigateTool(args: NavigateArgs): Promise<NavigateResult> {
  if (args.listTabs) {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return {
      tabs: tabs
        .filter((tab): tab is chrome.tabs.Tab & { id: number } => typeof tab.id === "number")
        .map((tab) => ({
          id: tab.id,
          url: tab.url ?? null,
          title: tab.title ?? null,
          active: Boolean(tab.active),
          windowId: tab.windowId,
        })),
    };
  }

  if (typeof args.switchToTab === "number") {
    const tab = await chrome.tabs.get(args.switchToTab);
    if (!tab?.id) throw new Error("Tab not found");
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    const skills = tab.url ? await listSkills(tab.url) : [];
    return {
      switchedToTab: tab.id,
      finalUrl: tab.url ?? null,
      title: tab.title ?? null,
      tabId: tab.id,
      skills: skills.map((skill) => ({
        name: skill.name,
        shortDescription: skill.shortDescription,
      })),
    };
  }

  const url = args.url?.trim();
  if (!url) throw new Error("Missing url");

  if (args.newTab) {
    const tab = await chrome.tabs.create({ url });
    if (!tab.id) throw new Error("Failed to open new tab");
    const finalTab = await waitForTabComplete(tab.id).catch(() => tab);
    const skills = finalTab.url ? await listSkills(finalTab.url) : [];
    return {
      finalUrl: finalTab.url ?? url,
      title: finalTab.title ?? null,
      tabId: finalTab.id,
      skills: skills.map((skill) => ({
        name: skill.name,
        shortDescription: skill.shortDescription,
      })),
    };
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  await chrome.tabs.update(tab.id, { url });
  const finalTab = await waitForTabComplete(tab.id).catch(() => tab);
  const skills = finalTab.url ? await listSkills(finalTab.url) : [];
  return {
    finalUrl: finalTab.url ?? url,
    title: finalTab.title ?? null,
    tabId: finalTab.id,
    skills: skills.map((skill) => ({
      name: skill.name,
      shortDescription: skill.shortDescription,
    })),
  };
}
