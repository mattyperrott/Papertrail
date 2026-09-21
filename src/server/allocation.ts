export interface AllocationCandidate {
  id: string;
  market: string;
  trader: string;
  event: string;
  desired: number;
  priority?: number;
}

export interface AllocationLimits {
  cash: number;
  portfolio: number;
  market: Record<string, number>;
  trader: Record<string, number>;
  event: Record<string, number>;
}

/**
 * Project all desired capital changes onto the same cash and concentration
 * constraints. Repeated proportional projection is deterministic, symmetric
 * between equal candidates, and prevents array order from consuming a bucket.
 */
export function allocateSimultaneously(candidates: AllocationCandidate[], limits: AllocationLimits) {
  const rows = candidates.map((candidate) => ({
    ...candidate,
    allocation: Math.max(0, Number.isFinite(candidate.desired) ? candidate.desired : 0),
  }));
  const scaleGroup = (members: typeof rows, cap: number) => {
    const total = members.reduce((sum, row) => sum + row.allocation, 0);
    if (total <= Math.max(0, cap) + 1e-9 || total <= 0) return false;
    const ratio = Math.max(0, cap) / total;
    for (const row of members) row.allocation *= ratio;
    return true;
  };
  for (let pass = 0; pass < 12; pass++) {
    let changed = false;
    changed = scaleGroup(rows, Math.min(limits.cash, limits.portfolio)) || changed;
    for (const field of ['market', 'trader', 'event'] as const) {
      const keys = new Set(rows.map((row) => row[field]));
      for (const key of keys) changed = scaleGroup(rows.filter((row) => row[field] === key), limits[field][key] ?? 0) || changed;
    }
    if (!changed) break;
  }
  return rows.map(({ allocation, ...candidate }) => ({ ...candidate, allocation }));
}
