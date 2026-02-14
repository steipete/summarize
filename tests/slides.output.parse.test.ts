import { describe, expect, it } from "vitest";
import { parseSlideSummariesFromMarkdown } from "../src/run/flows/url/slides-text.js";

describe("parseSlideSummariesFromMarkdown", () => {
  it("extracts slide summaries from Slides section", () => {
    const markdown = `
Intro paragraph.

### Slides
[slide:1] First summary line.
More detail.

[slide:3] Third summary.

### Next
Other section
`;
    const map = parseSlideSummariesFromMarkdown(markdown);
    expect(map.get(1)).toBe("First summary line.\nMore detail.");
    expect(map.get(3)).toBe("Third summary.");
  });

  it("parses slide labels with timestamps", () => {
    const markdown = `
Intro paragraph.

### Slides
Slide 1/10 \u00b7 0:01
First slide text.

Slide 2 of 10 - 1:05
Second slide text.
`;
    const map = parseSlideSummariesFromMarkdown(markdown);
    expect(map.get(1)).toBe("First slide text.");
    expect(map.get(2)).toBe("Second slide text.");
  });

  it("parses slide markers without a Slides heading", () => {
    const markdown = `
Intro paragraph.

[slide:1] First summary line.
More detail.

[slide:3] Third summary.
`;
    const map = parseSlideSummariesFromMarkdown(markdown);
    expect(map.get(1)).toBe("First summary line.\nMore detail.");
    expect(map.get(3)).toBe("Third summary.");
  });

  it("keeps empty slide markers", () => {
    const markdown = `
Intro paragraph.

### Slides
[slide:1]

[slide:2] Second summary.
`;
    const map = parseSlideSummariesFromMarkdown(markdown);
    expect(map.has(1)).toBe(true);
    expect(map.get(1)).toBe("");
    expect(map.get(2)).toBe("Second summary.");
  });

  it("parses slide blocks when content starts with headings", () => {
    const markdown = `
Intro paragraph.

### Slides
[slide:1]
## Opening
First block line.

[slide:2]
## Details
Second block line.
`;
    const map = parseSlideSummariesFromMarkdown(markdown);
    expect(map.get(1)).toBe("## Opening\nFirst block line.");
    expect(map.get(2)).toBe("## Details\nSecond block line.");
  });
});
