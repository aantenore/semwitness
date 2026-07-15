/**
 * Compare strings by UTF-16 code units without locale or runtime data.
 *
 * SemWitness identifiers are ASCII-constrained at policy boundaries, but this
 * comparator also keeps registry ordering deterministic for trusted adapters.
 */
export function compareCodeUnits(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
