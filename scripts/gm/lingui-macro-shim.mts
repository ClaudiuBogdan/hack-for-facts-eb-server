/**
 * Runtime stand-in for `@lingui/core/macro` and `@lingui/react/macro`.
 *
 * The client's Lingui macros are compile-time (babel-plugin-macros / the
 * Lingui SWC plugin turn `t\`…\`` into catalog lookups). Node has no such
 * compiler, so `scripts/gm/client-module-hooks.mts` resolves both macro
 * packages to this module, which returns the raw message text. The corpus
 * generator only needs the client's *builders* (filters, series ids, periods);
 * no localized text reaches a GraphQL variable.
 */

export interface MessageDescriptor {
  id: string;
  message: string;
}

function text(strings: unknown, ...values: unknown[]): string {
  if (typeof strings === 'string') return strings;
  if (Array.isArray(strings)) {
    return String.raw({ raw: strings as readonly string[] }, ...values.map(String));
  }
  if (strings !== null && typeof strings === 'object') {
    const descriptor = strings as Partial<MessageDescriptor>;
    return descriptor.message ?? descriptor.id ?? '';
  }
  return '';
}

export const t = text;
export const msg = (strings: unknown, ...values: unknown[]): MessageDescriptor => {
  const rendered = text(strings, ...values);
  return { id: rendered, message: rendered };
};
export const defineMessage = (descriptor: unknown): MessageDescriptor =>
  descriptor !== null && typeof descriptor === 'object'
    ? (descriptor as MessageDescriptor)
    : msg(descriptor);
export const plural = (_value: unknown, forms: { other?: string }): string => forms.other ?? '';
export const select = plural;
export const selectOrdinal = plural;
export const Trans = (): null => null;
export const Plural = (): null => null;
export const Select = (): null => null;
// eslint-disable-next-line @typescript-eslint/naming-convention -- `i18n._` is Lingui's API name
export const useLingui = (): { t: typeof text; i18n: { _: typeof text } } => ({
  t: text,
  i18n: { _: text },
});
