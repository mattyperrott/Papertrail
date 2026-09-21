export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const round = (value: number, decimals = 2) => {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

export const safeDivide = (numerator: number, denominator: number, fallback = 0) =>
  denominator === 0 ? fallback : numerator / denominator;
