/** Credits at or above this value are collapsed into a single "N 學分以上" filter chip. */
export const HIGH_CREDIT_THRESHOLD = 4;

/** The credit options that the combined "N 學分以上" chip stands for. */
export function getHighCreditOptions(creditOptions: number[]): number[] {
  return creditOptions.filter((credits) => credits >= HIGH_CREDIT_THRESHOLD);
}

/** The combined chip is only selected when every credit value it covers is selected. */
export function isHighCreditFilterSelected(selectedCredits: number[], highCreditOptions: number[]): boolean {
  return highCreditOptions.length > 0 && highCreditOptions.every((credits) => selectedCredits.includes(credits));
}

/** Toggle the combined chip, adding or removing every credit value it covers at once. */
export function toggleHighCreditFilter(selectedCredits: number[], highCreditOptions: number[]): number[] {
  if (isHighCreditFilterSelected(selectedCredits, highCreditOptions)) {
    return selectedCredits.filter((credits) => !highCreditOptions.includes(credits));
  }
  return [...new Set([...selectedCredits, ...highCreditOptions])];
}

/** Summarise the selected credit filters, folding the covered values back into the combined chip label. */
export function formatCreditFilterSummary(selectedCredits: number[], highCreditOptions: number[]): string {
  const highCreditSelected = isHighCreditFilterSelected(selectedCredits, highCreditOptions);
  const highCreditSet = new Set(highCreditOptions);
  const individualCredits = selectedCredits
    .filter((credits) => !highCreditSelected || !highCreditSet.has(credits))
    .sort((left, right) => left - right);
  const labels = individualCredits.map((credits) => `${credits} 學分`);
  if (highCreditSelected) labels.push(`${HIGH_CREDIT_THRESHOLD} 學分以上`);
  return labels.join("、");
}
