export const SUMMARY_LENGTHS = ['short', 'medium', 'long', 'xl', 'xxl'] as const
export type SummaryLength = (typeof SUMMARY_LENGTHS)[number]
