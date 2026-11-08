// Shared by supportAgent's tools and escalateWorkflow, so editing it changes both units.
export function formatLine(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}
