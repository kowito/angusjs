/**
 * "Did you mean …?" — the difference between an error that stops you and one
 * that fixes you.
 *
 * A leaf module: it imports nothing, so anything can use it without bending the
 * dependency direction. The CLI reaches for it on an unknown command, view sets
 * on a mistyped field, the query layer on an unknown lookup.
 */

/**
 * Damerau edit distance (the optimal-string-alignment variant), bounded.
 *
 * Counts an adjacent transposition as one edit, not two, because a swapped pair
 * — `titel` for `title` — is among the commonest typos, and plain Levenshtein
 * scoring it as 2 would push it past any threshold tight enough to reject
 * genuine nonsense. The distinction is the whole reason a suggestion can be both
 * eager on real typos and quiet on unrelated words.
 *
 * `max` lets the loop bail once the distance provably exceeds it, so comparing a
 * short typo against a long unrelated string stays cheap.
 */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1

  // Three rows: the transposition rule needs the row before the previous one.
  let beforePrevious = new Array<number>(b.length + 1)
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  let current = new Array<number>(b.length + 1)

  for (let i = 1; i <= a.length; i++) {
    current[0] = i
    let rowMin = current[0]!

    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let distance = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost)

      // A swap of two adjacent characters, charged as a single edit.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        distance = Math.min(distance, beforePrevious[j - 2]! + 1)
      }

      current[j] = distance
      if (distance < rowMin) rowMin = distance
    }

    // Every later row can only grow, so once a whole row clears the bound the
    // final distance does too.
    if (rowMin > max) return max + 1
    ;[beforePrevious, previous, current] = [previous, current, beforePrevious]
  }

  return previous[b.length]!
}

/**
 * The closest candidate to `target`, or null when nothing is close enough.
 *
 * The threshold scales with the word's length — a short word tolerates one
 * edit, a long one a few more — so a suggestion is only offered when it is
 * plausibly what the person meant, not merely the least-bad of a distant set.
 * Suggesting nonsense is worse than saying nothing, so this errs tight: `serer`
 * gets no suggestion rather than a confident wrong `seed`.
 */
export function nearest(target: string, candidates: Iterable<string>): string | null {
  const threshold = Math.max(1, Math.floor(target.length / 3))

  let best: string | null = null
  let bestDistance = threshold + 1

  for (const candidate of candidates) {
    const distance = editDistance(target, candidate, bestDistance)
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
      if (distance === 0) break
    }
  }

  return best
}

/**
 * A ready-to-append suggestion clause, or an empty string.
 *
 * Written so a caller can always concatenate it — `throw new Error(msg +
 * didYouMean(...))` — without branching on whether a suggestion was found.
 */
export function didYouMean(target: string, candidates: Iterable<string>): string {
  const match = nearest(target, candidates)
  return match ? ` Did you mean "${match}"?` : ''
}
