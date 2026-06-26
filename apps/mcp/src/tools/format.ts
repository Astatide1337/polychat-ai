export function omitRaw<T extends { raw: unknown }>(value: T): Omit<T, "raw"> {
  const { raw: _raw, ...rest } = value;
  return rest as Omit<T, "raw">;
}
