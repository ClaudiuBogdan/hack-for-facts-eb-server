/** Signs and verifies stateless unsubscribe tokens. */
export interface UnsubscribeTokenSigner {
  sign(userId: string): string;
  verify(token: string): { userId: string } | null;
}
