/**
 * AI/LLM prompt patterns for summarization and extraction.
 * Each pattern provides task-specific instructions that replace the default
 * summarization behavior when selected.
 */

export type PatternDef = {
  id: string;
  label: string;
  description: string;
  prompt: string;
};

/** All available patterns, keyed by id */
export const PATTERNS: readonly PatternDef[] = [
  {
    id: "create_mermaid_visualization",
    label: "Mermaid diagram",
    description: "Generate a Mermaid diagram from the content",
    prompt: `Create a Mermaid diagram that visualizes the key concepts, flow, or structure from the content.
Output only valid Mermaid syntax (flowchart, sequenceDiagram, classDiagram, etc.). Choose the diagram type that best fits the content.
Do not include explanatory text before or after the diagram.`,
  },
  {
    id: "create_prd",
    label: "PRD",
    description: "Generate a Product Requirements Document",
    prompt: `Convert this content into a structured Product Requirements Document (PRD) with:
- Overview & objectives
- User stories and use cases
- Functional requirements
- Non-functional requirements
- Success metrics
- Out of scope
Use clear Markdown headings and bullet lists.`,
  },
  {
    id: "extract_business_ideas",
    label: "Business ideas",
    description: "Extract business ideas and opportunities",
    prompt: `Extract all business ideas, opportunities, and entrepreneurial concepts mentioned in the content.
List each with a brief description and the supporting reasoning from the source.
Format as a bullet list with concise entries.`,
  },
  {
    id: "create_video_chapters",
    label: "Video chapters",
    description: "Create chapter markers for video content",
    prompt: `Create chapter markers for this transcript/video content.
For each chapter: provide a [mm:ss] or [hh:mm:ss] timestamp and a short chapter title.
Order chronologically. Aim for 5–12 chapters depending on length.`,
  },
  {
    id: "create_summary",
    label: "Summary",
    description: "Standard concise summary",
    prompt: `Summarize the content concisely. Include the main points, key takeaways, and any important details.
Use short paragraphs and bullet lists where appropriate. Write in direct, factual language.`,
  },
  {
    id: "extract_wisdom",
    label: "Extract wisdom",
    description: "Extract key wisdom and insights",
    prompt: `Extract the most valuable wisdom, insights, and lessons from this content.
Focus on actionable ideas, memorable quotes, and principles that generalize.
Format as a numbered or bullet list with brief explanations.`,
  },
  {
    id: "extract_skills",
    label: "Extract skills",
    description: "Extract skills and competencies mentioned",
    prompt: `Extract all skills, competencies, techniques, or domains explicitly or implicitly mentioned in the content.
Group by category where helpful. Include brief context for each.
Format as a structured list.`,
  },
  {
    id: "summarize",
    label: "Summarize",
    description: "General-purpose summary",
    prompt: `Provide a clear, balanced summary of the content. Cover the main argument or narrative, key facts, and conclusions.
Avoid filler and speculation. Use Markdown for readability.`,
  },
  {
    id: "summarize_board_meeting",
    label: "Board meeting",
    description: "Summarize as a board meeting brief",
    prompt: `Summarize this content as a board meeting brief: executive summary, key decisions or recommendations, risks, and action items.
Use formal, concise language. Highlight items requiring board attention.`,
  },
  {
    id: "summarize_debate",
    label: "Debate",
    description: "Summarize a debate or discussion",
    prompt: `Summarize this debate or discussion by:
- Stating the main question or topic
- Outlining each side's position and key arguments
- Noting areas of agreement and disagreement
- Concluding with any resolution or open questions`,
  },
  {
    id: "summarize_git_changes",
    label: "Git changes",
    description: "Summarize git commit/PR changes",
    prompt: `Summarize these git changes (commits, diff, or PR). Highlight:
- What was added, changed, or removed
- The intent behind the changes
- Any notable patterns or risks
Keep it technical but readable.`,
  },
  {
    id: "summarize_git_diff",
    label: "Git diff",
    description: "Summarize a git diff",
    prompt: `Summarize this git diff. Explain the nature of the changes, affected areas, and overall impact.
Use a brief paragraph plus bullet points for file-level or logical groupings.`,
  },
  {
    id: "summarize_lecture",
    label: "Lecture",
    description: "Summarize as lecture notes",
    prompt: `Summarize this content as lecture or study notes. Include:
- Main topics and subtopics
- Key definitions and concepts
- Important examples or evidence
- Takeaway points for revision
Use clear headings and lists.`,
  },
  {
    id: "summarize_legislation",
    label: "Legislation",
    description: "Summarize legislation or legal text",
    prompt: `Summarize this legislative or legal content. Include:
- Purpose and scope
- Key provisions and requirements
- Obligations and implications
- Effective dates or conditions
Use neutral, precise language.`,
  },
  {
    id: "summarize_meeting",
    label: "Meeting notes",
    description: "Summarize as meeting notes",
    prompt: `Summarize this as meeting notes: attendees and context, discussion points, decisions made, action items with owners if identifiable.
Format with clear sections. Use past tense.`,
  },
  {
    id: "summarize_micro",
    label: "Micro summary",
    description: "Ultra-short summary (1-3 sentences)",
    prompt: `Summarize in 1-3 sentences. Capture only the core message or outcome. No bullet points or extra sections.`,
  },
  {
    id: "summarize_newsletter",
    label: "Newsletter",
    description: "Summarize as newsletter style",
    prompt: `Summarize in newsletter style: engaging intro, main sections with short paragraphs, key quotes or stats, and a brief wrap-up.
Tone: informative but readable for a general audience.`,
  },
  {
    id: "summarize_paper",
    label: "Academic paper",
    description: "Summarize an academic paper",
    prompt: `Summarize this academic content: research question, methodology, main findings, limitations, and implications.
Use scholarly but accessible language. Preserve important citations or data points.`,
  },
  {
    id: "summarize_prompt",
    label: "Prompt-style summary",
    description: "Summary as an LLM prompt",
    prompt: `Summarize this content in a format suitable for use as an LLM prompt or context block.
Preserve key facts, structure, and requirements. Be concise but complete enough for downstream use.`,
  },
] as const;

export const PATTERN_IDS = PATTERNS.map((p) => p.id);

/** Quick-access patterns for the sidepanel dropdown */
export const QUICK_PATTERNS: readonly { id: string; label: string }[] = [
  { id: "extract_wisdom", label: "Extract wisdom" },
  { id: "summarize", label: "Summarize" },
  { id: "create_mermaid_visualization", label: "Visualize" },
];

export function getPattern(id: string): PatternDef | null {
  return PATTERNS.find((p) => p.id === id) ?? null;
}

export function getPatternPrompt(id: string): string | null {
  const p = getPattern(id);
  return p ? p.prompt : null;
}
