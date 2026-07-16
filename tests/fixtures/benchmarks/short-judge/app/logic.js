export function rankOptions(options, choices) {
  const scores = options.map(() => 0)
  const pairs = []
  for (let left = 0; left < options.length; left += 1) {
    for (let right = left + 1; right < options.length; right += 1) pairs.push([left, right])
  }

  pairs.forEach(([left, right], index) => {
    scores[choices[index] === 'right' ? right : left] += 1
  })

  return options
    .map((label, index) => ({ label, index, score: scores[index] }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ label }) => label)
}

export function pairsFor(options) {
  const pairs = []
  for (let left = 0; left < options.length; left += 1) {
    for (let right = left + 1; right < options.length; right += 1) pairs.push([left, right])
  }
  return pairs
}
