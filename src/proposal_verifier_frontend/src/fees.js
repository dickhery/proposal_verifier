export const ICP_E8S_PER_ICP = 100_000_000n;

export const FETCH_PROPOSAL_FEE_E8S = 10_000_000n;
export const NETWORK_FEE_E8S = 10_000n;

function toE8sNumber(value) {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  if (value == null) return 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    try {
      return Number(BigInt(trimmed));
    } catch (err) {
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : 0;
    }
  }
  if (typeof value === 'object' && value) {
    try {
      const primitive = value.valueOf();
      if (primitive !== value) {
        return toE8sNumber(primitive);
      }
    } catch (err) {
      // ignore
    }
  }
  return 0;
}

export function e8sToIcpNumber(value) {
  return toE8sNumber(value) / Number(ICP_E8S_PER_ICP);
}

export function formatFeeIcp(value) {
  const amount = e8sToIcpNumber(value);
  const decimals = amount >= 1 ? 2 : 1;
  return amount.toFixed(decimals);
}

export function formatIcp(value, { minFractionDigits, maxFractionDigits } = {}) {
  const amount = e8sToIcpNumber(value);
  const min =
    minFractionDigits !== undefined ? minFractionDigits : amount >= 1 ? 2 : 4;
  const max =
    maxFractionDigits !== undefined ? maxFractionDigits : Math.max(min, 8);
  return amount.toLocaleString(undefined, {
    minimumFractionDigits: min,
    maximumFractionDigits: max,
  });
}
