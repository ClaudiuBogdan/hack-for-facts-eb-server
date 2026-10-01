/** Current client routes; registry escaping is reversible for literal hyphens and tildes. */
export const ngoProfileLink = (
  clientBaseUrl: string,
  cui: string | null | undefined,
  registryNumber?: string
): string => {
  if (cui !== null && cui !== undefined) return `${clientBaseUrl}/ngos/${encodeURIComponent(cui)}`;
  if (registryNumber === undefined) return `${clientBaseUrl}/ngos/registry`;
  const slug = registryNumber.replaceAll('~', '~~').replaceAll('-', '~-').replaceAll('/', '-');
  return `${clientBaseUrl}/ngos/registry/${encodeURIComponent(slug)}`;
};
