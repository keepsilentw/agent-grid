// Error-message extraction for `catch` blocks: caught values are `unknown`
// under strict TypeScript, and every CLI here reports failures as text.
export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
