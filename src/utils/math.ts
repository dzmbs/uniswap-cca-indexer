export const MPS = 10_000_000n;
export const Q96 = 0x1000000000000000000000000n; // 2^96
export const RESOLUTION = 96n;

export function q96ToWei(valueQ96: bigint): bigint {
  return valueQ96 >> RESOLUTION;
}
